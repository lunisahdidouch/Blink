//! HLS download (`hls` mode): fetch master → variant playlist → every segment, then write a
//! local VOD playlist with relative URIs.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header;
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::file_job::{
    map_io, map_reqwest, map_status, part_path, sleep_or_cancel, AttemptError, JobProgress,
};
use super::model::{ErrorCode, ErrorInfo};

pub const PLAYLIST: &str = "index.m3u8";
pub const PLAYLIST_PART: &str = "index.m3u8.part";
pub const INIT_SEGMENT: &str = "init.mp4";

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    /// The original `#EXTINF:…` line, kept verbatim.
    pub extinf: String,
    pub duration: f64,
    pub uri: Url,
    pub ext: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MediaPlaylist {
    /// Kept header tags (`#EXT-X-VERSION`, `#EXT-X-TARGETDURATION`, `#EXT-X-MEDIA-SEQUENCE`).
    pub header: Vec<String>,
    /// `#EXT-X-MAP` URI (fMP4 init segment).
    pub map: Option<Url>,
    pub segments: Vec<Segment>,
}

fn refused(msg: impl Into<String>) -> ErrorInfo {
    ErrorInfo::new(ErrorCode::ServerRefused, msg)
}

fn join(base: &Url, uri: &str) -> Result<Url, ErrorInfo> {
    base.join(uri)
        .map_err(|e| refused(format!("invalid playlist URI {uri:?}: {e}")))
}

/// Return the first `#EXT-X-STREAM-INF` variant, or `None` if `text` is already a media playlist.
pub fn resolve_variant(text: &str, master_url: &Url) -> Result<Option<Url>, ErrorInfo> {
    if !text.trim_start().starts_with("#EXTM3U") {
        return Err(refused("the server did not return an HLS playlist"));
    }
    let mut in_stream_inf = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with("#EXT-X-STREAM-INF") {
            in_stream_inf = true;
        } else if in_stream_inf && !line.is_empty() && !line.starts_with('#') {
            return join(master_url, line).map(Some);
        }
    }
    if in_stream_inf {
        return Err(refused("master playlist has no variant URI"));
    }
    Ok(None)
}

fn attr_uri(line: &str) -> Option<&str> {
    let start = line.find("URI=\"")? + 5;
    let end = line[start..].find('"')? + start;
    Some(&line[start..end])
}

/// Extension of the last path segment (`ts`, `mp4`, `m4s`, …); defaults to `ts`.
pub fn ext_of(url: &Url) -> String {
    url.path_segments()
        .and_then(|mut s| s.next_back())
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| !ext.is_empty() && ext.len() <= 4 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "ts".into())
}

pub fn segment_file(index: usize, ext: &str) -> String {
    format!("seg{index:05}.{ext}")
}

pub fn parse_media(text: &str, url: &Url) -> Result<MediaPlaylist, ErrorInfo> {
    if !text.trim_start().starts_with("#EXTM3U") {
        return Err(refused("the server did not return an HLS playlist"));
    }
    let mut header = Vec::new();
    let mut map = None;
    let mut segments = Vec::new();
    let mut pending: Option<(String, f64)> = None;
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line == "#EXTM3U" {
            continue;
        }
        if line.starts_with("#EXT-X-VERSION")
            || line.starts_with("#EXT-X-TARGETDURATION")
            || line.starts_with("#EXT-X-MEDIA-SEQUENCE")
        {
            header.push(line.to_string());
        } else if line.starts_with("#EXT-X-MAP:") {
            let uri = attr_uri(line).ok_or_else(|| refused("#EXT-X-MAP without URI"))?;
            map = Some(join(url, uri)?);
        } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let dur = rest.split(',').next().unwrap_or("").trim();
            let duration = dur
                .parse::<f64>()
                .map_err(|_| refused(format!("bad #EXTINF duration {dur:?}")))?;
            pending = Some((line.to_string(), duration));
        } else if line.starts_with('#') {
            // Other tags are dropped.
        } else if let Some((extinf, duration)) = pending.take() {
            let uri = join(url, line)?;
            let ext = ext_of(&uri);
            segments.push(Segment {
                extinf,
                duration,
                uri,
                ext,
            });
        }
    }
    if segments.is_empty() {
        return Err(refused("the playlist has no segments"));
    }
    Ok(MediaPlaylist {
        header,
        map,
        segments,
    })
}

/// Local VOD playlist with relative URIs.
pub fn rewrite(pl: &MediaPlaylist) -> String {
    let mut out = String::from("#EXTM3U\n");
    for h in &pl.header {
        out.push_str(h);
        out.push('\n');
    }
    out.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n");
    if pl.map.is_some() {
        out.push_str(&format!("#EXT-X-MAP:URI=\"{INIT_SEGMENT}\"\n"));
    }
    for (i, s) in pl.segments.iter().enumerate() {
        out.push_str(&s.extinf);
        out.push('\n');
        out.push_str(&segment_file(i, &s.ext));
        out.push('\n');
    }
    out.push_str("#EXT-X-ENDLIST\n");
    out
}

/// Same number of segments with identical `#EXTINF` durations (and file names).
pub fn same_layout(a: &str, b: &str) -> bool {
    let pick = |s: &str| -> Vec<String> {
        s.lines()
            .map(str::trim)
            .filter(|l| l.starts_with("#EXTINF") || l.starts_with("seg") || l.starts_with("#EXT-X-MAP"))
            .map(String::from)
            .collect()
    };
    pick(a) == pick(b)
}

pub struct HlsJob {
    pub client: reqwest::Client,
    pub master_url: String,
    pub auth_header: String,
    /// The item folder; segments go to `{dir}/hls/`.
    pub dir: PathBuf,
    pub cancel: CancellationToken,
    pub progress: watch::Sender<JobProgress>,
    /// `progress.segmentsDone` from the manifest, for resume.
    pub start_segments_done: u32,
    /// Plan: 180 s per segment (the first ones may wait for the transcode to start).
    pub segment_timeout: Duration,
    /// Plan: 3 retries.
    pub retry_delays: Vec<Duration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HlsOutcome {
    pub bytes: u64,
    pub segments: u32,
}

pub fn default_segment_retry_delays() -> Vec<Duration> {
    [2, 4, 8].into_iter().map(Duration::from_secs).collect()
}

async fn non_empty_len(p: &Path) -> Option<u64> {
    tokio::fs::metadata(p).await.ok().map(|m| m.len()).filter(|l| *l > 0)
}

impl HlsJob {
    pub async fn run(&self) -> Result<HlsOutcome, ErrorInfo> {
        let hls_dir = self.dir.join("hls");
        let master_url = Url::parse(&self.master_url).map_err(|e| refused(e.to_string()))?;
        let master_text = self.get_text(&master_url).await?;
        let (media_url, media_text) = match resolve_variant(&master_text, &master_url)? {
            Some(v) => {
                let t = self.get_text(&v).await?;
                (v, t)
            }
            None => (master_url.clone(), master_text),
        };
        let pl = parse_media(&media_text, &media_url)?;
        let local = rewrite(&pl);
        let total = pl.segments.len() as u32;

        let part_pl = hls_dir.join(PLAYLIST_PART);
        let mut start = self.start_segments_done.min(total);
        match tokio::fs::read_to_string(&part_pl).await {
            Ok(old) if same_layout(&old, &local) => {}
            Ok(_) => {
                log::info!("HLS layout changed on the server; restarting from segment 0");
                let _ = tokio::fs::remove_dir_all(&hls_dir).await;
                start = 0;
            }
            Err(_) => {
                if hls_dir.exists() {
                    let _ = tokio::fs::remove_dir_all(&hls_dir).await;
                }
                start = 0;
            }
        }
        tokio::fs::create_dir_all(&hls_dir)
            .await
            .map_err(|e| map_io(e).info)?;
        tokio::fs::write(&part_pl, &local)
            .await
            .map_err(|e| map_io(e).info)?;

        let mut bytes = 0u64;
        for (i, s) in pl.segments.iter().enumerate().take(start as usize) {
            match non_empty_len(&hls_dir.join(segment_file(i, &s.ext))).await {
                Some(l) => bytes += l,
                None => {
                    start = i as u32;
                    break;
                }
            }
        }
        self.progress.send_modify(|p| {
            p.bytes_done = bytes;
            p.segments_done = Some(start);
            p.segments_total = Some(total);
        });

        if let Some(map) = &pl.map {
            let dest = hls_dir.join(INIT_SEGMENT);
            if non_empty_len(&dest).await.is_none() {
                bytes += self.fetch_with_retry(map, &dest).await?;
            }
        }

        for (i, s) in pl.segments.iter().enumerate().skip(start as usize) {
            let dest = hls_dir.join(segment_file(i, &s.ext));
            bytes += self.fetch_with_retry(&s.uri, &dest).await?;
            self.progress.send_modify(|p| {
                p.bytes_done = bytes;
                p.segments_done = Some(i as u32 + 1);
            });
        }

        super::manifest::rename_with_retry(&part_pl, &hls_dir.join(PLAYLIST))
            .map_err(|e| map_io(e).info)?;
        self.progress.send_modify(|p| p.bytes_total = Some(bytes));
        Ok(HlsOutcome {
            bytes,
            segments: total,
        })
    }

    async fn get_text(&self, url: &Url) -> Result<String, ErrorInfo> {
        let mut attempt = 0;
        loop {
            match self.get_text_once(url).await {
                Ok(t) => return Ok(t),
                Err(e) if e.retry && attempt < self.retry_delays.len() => {
                    sleep_or_cancel(self.retry_delays[attempt], &self.cancel)
                        .await
                        .map_err(|e| e.info)?;
                    attempt += 1;
                }
                Err(e) => return Err(e.info),
            }
        }
    }

    async fn get_text_once(&self, url: &Url) -> Result<String, AttemptError> {
        let req = self
            .client
            .get(url.clone())
            .header(header::AUTHORIZATION, &self.auth_header)
            .timeout(self.segment_timeout);
        let resp = tokio::select! {
            _ = self.cancel.cancelled() => return Err(AttemptError::cancelled()),
            r = req.send() => r.map_err(map_reqwest)?,
        };
        if !resp.status().is_success() {
            return Err(map_status(resp.status()));
        }
        tokio::select! {
            _ = self.cancel.cancelled() => Err(AttemptError::cancelled()),
            t = resp.text() => t.map_err(map_reqwest),
        }
    }

    async fn fetch_with_retry(&self, url: &Url, dest: &Path) -> Result<u64, ErrorInfo> {
        let mut attempt = 0;
        loop {
            match self.fetch_once(url, dest).await {
                Ok(n) => return Ok(n),
                Err(e) if e.retry && attempt < self.retry_delays.len() => {
                    log::warn!("segment {} failed: {}", dest.display(), e.info);
                    sleep_or_cancel(self.retry_delays[attempt], &self.cancel)
                        .await
                        .map_err(|e| e.info)?;
                    attempt += 1;
                }
                Err(e) => return Err(e.info),
            }
        }
    }

    async fn fetch_once(&self, url: &Url, dest: &Path) -> Result<u64, AttemptError> {
        let work = async {
            let resp = self
                .client
                .get(url.clone())
                .header(header::AUTHORIZATION, &self.auth_header)
                .send()
                .await
                .map_err(map_reqwest)?;
            if !resp.status().is_success() {
                return Err(map_status(resp.status()));
            }
            let tmp = part_path(dest);
            let mut file = tokio::fs::File::create(&tmp).await.map_err(map_io)?;
            let mut stream = resp.bytes_stream();
            let mut n = 0u64;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(map_reqwest)?;
                file.write_all(&chunk).await.map_err(map_io)?;
                n += chunk.len() as u64;
            }
            file.flush().await.map_err(map_io)?;
            drop(file);
            if n == 0 {
                return Err(AttemptError::retry(ErrorCode::Network, "empty segment"));
            }
            super::manifest::rename_with_retry(&tmp, dest).map_err(map_io)?;
            Ok(n)
        };
        tokio::select! {
            _ = self.cancel.cancelled() => Err(AttemptError::cancelled()),
            r = tokio::time::timeout(self.segment_timeout, work) => match r {
                Err(_) => Err(AttemptError::retry(ErrorCode::Network, "segment timed out")),
                Ok(r) => r,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::Path as AxPath, http::StatusCode, routing::get, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn fixture(name: &str) -> String {
        let p = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name);
        std::fs::read_to_string(p).unwrap()
    }

    fn base() -> Url {
        Url::parse("http://server:8096/videos/abc/master.m3u8?PlaySessionId=p1").unwrap()
    }

    #[test]
    fn master_picks_first_variant() {
        let v = resolve_variant(&fixture("jellyfin_master.m3u8"), &base()).unwrap().unwrap();
        assert_eq!(v.path(), "/videos/abc/main.m3u8");
        assert!(v.query().unwrap().contains("PlaySessionId=p1"));
        assert_eq!(resolve_variant(&fixture("jellyfin_variant_ts.m3u8"), &base()).unwrap(), None);
        assert!(resolve_variant("<html>", &base()).is_err());
    }

    #[test]
    fn ts_variant_is_rewritten() {
        let url = base().join("main.m3u8").unwrap();
        let pl = parse_media(&fixture("jellyfin_variant_ts.m3u8"), &url).unwrap();
        assert_eq!(pl.segments.len(), 4);
        assert_eq!(pl.segments[0].ext, "ts");
        assert_eq!(pl.segments[0].uri.path(), "/videos/abc/hls1/main/0.ts");
        assert!(pl.segments[0].uri.query().unwrap().contains("runtimeTicks=0"));
        assert!((pl.segments[3].duration - 1.5).abs() < 1e-9);
        assert!(pl.map.is_none());
        let out = rewrite(&pl);
        assert_eq!(out, fixture("expected_ts_index.m3u8").replace("\r\n", "\n"));
    }

    #[test]
    fn fmp4_variant_has_init_segment() {
        let url = base().join("main.m3u8").unwrap();
        let pl = parse_media(&fixture("jellyfin_variant_fmp4.m3u8"), &url).unwrap();
        assert_eq!(pl.map.as_ref().unwrap().path(), "/videos/abc/hls1/main/-1.mp4");
        assert_eq!(pl.segments[0].ext, "mp4");
        let out = rewrite(&pl);
        assert!(out.contains("#EXT-X-MAP:URI=\"init.mp4\"\n"));
        assert!(out.contains("seg00000.mp4\n"));
        assert!(out.contains("#EXT-X-VERSION:7\n"));
        assert!(out.ends_with("#EXT-X-ENDLIST\n"));
        assert_eq!(out.matches("#EXT-X-PLAYLIST-TYPE:VOD").count(), 1);
        assert!(!out.contains("http"));
    }

    #[test]
    fn layout_comparison() {
        let url = base().join("main.m3u8").unwrap();
        let a = rewrite(&parse_media(&fixture("jellyfin_variant_ts.m3u8"), &url).unwrap());
        let b = a.replace("#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-FOO");
        assert!(same_layout(&a, &b));
        let c = a.replace("#EXTINF:1.500000", "#EXTINF:1.400000");
        assert!(!same_layout(&a, &c));
        assert!(!same_layout(&a, ""));
    }

    #[test]
    fn extension_detection() {
        let u = |s| Url::parse(s).unwrap();
        assert_eq!(ext_of(&u("http://h/a/0.ts?x=1")), "ts");
        assert_eq!(ext_of(&u("http://h/a/0.M4S")), "m4s");
        assert_eq!(ext_of(&u("http://h/a/segment")), "ts");
    }

    struct Hls {
        segments: usize,
        fail_segment_once: Option<usize>,
        hits: AtomicUsize,
        failed: AtomicUsize,
        auth_seen: AtomicUsize,
    }

    async fn serve_hls(hls: Arc<Hls>) -> String {
        let h1 = hls.clone();
        let h2 = hls.clone();
        let h3 = hls.clone();
        let app = Router::new()
            .route(
                "/videos/abc/master.m3u8",
                get(move |headers: axum::http::HeaderMap| {
                    let h = h1.clone();
                    async move {
                        if headers.get("authorization").is_some() {
                            h.auth_seen.fetch_add(1, Ordering::SeqCst);
                        }
                        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmain.m3u8?PlaySessionId=p1\n"
                    }
                }),
            )
            .route(
                "/videos/abc/main.m3u8",
                get(move || {
                    let h = h2.clone();
                    async move {
                        let mut s = String::from("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n");
                        for i in 0..h.segments {
                            s.push_str(&format!("#EXTINF:3.000000, nodesc\nhls1/main/{i}.ts?runtimeTicks={}\n", i * 30_000_000));
                        }
                        s.push_str("#EXT-X-ENDLIST\n");
                        s
                    }
                }),
            )
            .route(
                "/videos/abc/hls1/main/{seg}",
                get(move |AxPath(seg): AxPath<String>| {
                    let h = h3.clone();
                    async move {
                        h.hits.fetch_add(1, Ordering::SeqCst);
                        let n: usize = seg.trim_end_matches(".ts").parse().unwrap();
                        if h.fail_segment_once == Some(n) && h.failed.fetch_add(1, Ordering::SeqCst) == 0 {
                            return Err(StatusCode::INTERNAL_SERVER_ERROR);
                        }
                        Ok(vec![n as u8; 1000 + n])
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/videos/abc/master.m3u8?PlaySessionId=p1")
    }

    fn job(url: String, dir: &Path, start: u32) -> (HlsJob, watch::Receiver<JobProgress>) {
        let (tx, rx) = watch::channel(JobProgress::default());
        (
            HlsJob {
                client: reqwest::Client::new(),
                master_url: url,
                auth_header: "MediaBrowser Token=\"t\"".into(),
                dir: dir.to_path_buf(),
                cancel: CancellationToken::new(),
                progress: tx,
                start_segments_done: start,
                segment_timeout: Duration::from_secs(10),
                retry_delays: vec![Duration::from_millis(10); 3],
            },
            rx,
        )
    }

    #[tokio::test]
    async fn downloads_all_segments_and_writes_playlist() {
        let tmp = tempfile::tempdir().unwrap();
        let hls = Arc::new(Hls {
            segments: 5,
            fail_segment_once: Some(2),
            hits: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            auth_seen: AtomicUsize::new(0),
        });
        let url = serve_hls(hls.clone()).await;
        let (j, rx) = job(url, tmp.path(), 0);
        let out = j.run().await.unwrap();
        assert_eq!(out.segments, 5);
        assert_eq!(out.bytes, (0..5).map(|n| 1000 + n as u64).sum::<u64>());
        assert_eq!(rx.borrow().segments_done, Some(5));
        let pl = std::fs::read_to_string(tmp.path().join("hls").join(PLAYLIST)).unwrap();
        assert!(pl.contains("seg00004.ts"));
        assert!(!tmp.path().join("hls").join(PLAYLIST_PART).exists());
        assert_eq!(std::fs::read(tmp.path().join("hls/seg00003.ts")).unwrap(), vec![3u8; 1003]);
        assert_eq!(hls.auth_seen.load(Ordering::SeqCst), 1);
        assert_eq!(hls.hits.load(Ordering::SeqCst), 6, "segment 2 retried once");
    }

    #[tokio::test]
    async fn resume_skips_done_segments_and_restarts_on_layout_change() {
        let tmp = tempfile::tempdir().unwrap();
        let hls = Arc::new(Hls {
            segments: 4,
            fail_segment_once: None,
            hits: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            auth_seen: AtomicUsize::new(0),
        });
        let url = serve_hls(hls.clone()).await;
        // First run fully, then pretend only 2 segments were done and the final playlist is missing.
        let (j, _) = job(url.clone(), tmp.path(), 0);
        j.run().await.unwrap();
        let hls_dir = tmp.path().join("hls");
        std::fs::rename(hls_dir.join(PLAYLIST), hls_dir.join(PLAYLIST_PART)).unwrap();
        std::fs::remove_file(hls_dir.join("seg00002.ts")).unwrap();
        std::fs::remove_file(hls_dir.join("seg00003.ts")).unwrap();
        hls.hits.store(0, Ordering::SeqCst);
        let (j, _) = job(url.clone(), tmp.path(), 2);
        j.run().await.unwrap();
        assert_eq!(hls.hits.load(Ordering::SeqCst), 2);

        // A stored playlist with a different layout forces a restart from 0.
        std::fs::rename(hls_dir.join(PLAYLIST), hls_dir.join(PLAYLIST_PART)).unwrap();
        let old = std::fs::read_to_string(hls_dir.join(PLAYLIST_PART)).unwrap();
        std::fs::write(hls_dir.join(PLAYLIST_PART), old.replacen("#EXTINF:3.000000", "#EXTINF:2.000000", 1)).unwrap();
        hls.hits.store(0, Ordering::SeqCst);
        let (j, _) = job(url, tmp.path(), 4);
        j.run().await.unwrap();
        assert_eq!(hls.hits.load(Ordering::SeqCst), 4);
    }
}
