//! Resumable single-file HTTP download (`file` mode).

use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{header, StatusCode};
use tokio::io::{AsyncSeekExt, AsyncWriteExt, BufWriter};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::model::{ErrorCode, ErrorInfo};

/// Live progress written by a job and sampled by the manager.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JobProgress {
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub segments_done: Option<u32>,
    pub segments_total: Option<u32>,
}

pub struct FileJob {
    pub client: reqwest::Client,
    pub url: String,
    pub auth_header: String,
    pub final_path: PathBuf,
    pub expected_bytes: Option<u64>,
    pub cancel: CancellationToken,
    pub progress: watch::Sender<JobProgress>,
    /// Backoff between retries of network/5xx/size errors. Plan: 2/4/8/16/32 s.
    pub retry_delays: Vec<Duration>,
    /// Per-chunk read timeout (not for the whole request). Plan: 60 s.
    pub read_timeout: Duration,
}

pub fn default_retry_delays() -> Vec<Duration> {
    [2, 4, 8, 16, 32].into_iter().map(Duration::from_secs).collect()
}

pub fn part_path(final_path: &std::path::Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// Error from one attempt; `retry` decides whether the outer loop tries again.
#[derive(Debug)]
pub(crate) struct AttemptError {
    pub info: ErrorInfo,
    pub retry: bool,
}

impl AttemptError {
    pub fn fatal(code: ErrorCode, msg: impl Into<String>) -> Self {
        Self {
            info: ErrorInfo::new(code, msg),
            retry: false,
        }
    }
    pub fn retry(code: ErrorCode, msg: impl Into<String>) -> Self {
        Self {
            info: ErrorInfo::new(code, msg),
            retry: true,
        }
    }
    pub fn cancelled() -> Self {
        Self::fatal(ErrorCode::Cancelled, "cancelled")
    }
}

pub(crate) fn map_io(e: std::io::Error) -> AttemptError {
    if is_disk_full(&e) {
        AttemptError::fatal(ErrorCode::DiskFull, "the disk is full")
    } else {
        AttemptError::fatal(ErrorCode::Io, e.to_string())
    }
}

pub fn is_disk_full(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::StorageFull {
        return true;
    }
    match e.raw_os_error() {
        // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL
        Some(39) | Some(112) if cfg!(windows) => true,
        // ENOSPC
        Some(28) if !cfg!(windows) => true,
        _ => false,
    }
}

pub(crate) fn map_status(status: StatusCode) -> AttemptError {
    match status.as_u16() {
        401 | 403 => AttemptError::fatal(ErrorCode::Unauthorized, format!("server returned {status}")),
        404 => AttemptError::fatal(ErrorCode::NotFound, "the item no longer exists on the server"),
        400..=499 => AttemptError::fatal(ErrorCode::ServerRefused, format!("server returned {status}")),
        _ => AttemptError::retry(ErrorCode::Network, format!("server returned {status}")),
    }
}

pub(crate) fn map_reqwest(e: reqwest::Error) -> AttemptError {
    AttemptError::retry(ErrorCode::Network, e.to_string())
}

/// Parse `Content-Range: bytes 100-199/1000` → (start, Some(total)); `bytes */1000` → (None, total).
pub fn parse_content_range(v: &str) -> (Option<u64>, Option<u64>) {
    let v = v.trim();
    let Some(rest) = v.strip_prefix("bytes ") else {
        return (None, None);
    };
    let (range, total) = rest.split_once('/').unwrap_or((rest, "*"));
    let total = total.trim().parse().ok();
    let start = range.split_once('-').and_then(|(s, _)| s.trim().parse().ok());
    (start, total)
}

/// Wait for `d` unless cancelled first.
pub(crate) async fn sleep_or_cancel(d: Duration, cancel: &CancellationToken) -> Result<(), AttemptError> {
    tokio::select! {
        _ = cancel.cancelled() => Err(AttemptError::cancelled()),
        _ = tokio::time::sleep(d) => Ok(()),
    }
}

async fn file_len(path: &std::path::Path) -> u64 {
    tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0)
}

async fn truncate(path: &std::path::Path) -> Result<(), AttemptError> {
    match tokio::fs::File::create(path).await {
        Ok(_) => Ok(()),
        Err(e) => Err(map_io(e)),
    }
}

impl FileJob {
    /// Download to `{final}.part`, resuming from its length, then rename to `final`.
    /// Returns the final size. A cancel keeps the `.part`.
    pub async fn run(&self) -> Result<u64, ErrorInfo> {
        if let Ok(meta) = tokio::fs::metadata(&self.final_path).await {
            if self.expected_bytes.is_none_or(|e| e == meta.len()) {
                self.report(meta.len(), Some(meta.len()));
                return Ok(meta.len());
            }
        }
        let part = part_path(&self.final_path);
        if let Some(parent) = part.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| map_io(e).info)?;
        }
        let mut attempt = 0usize;
        loop {
            match self.attempt(&part).await {
                Ok(size) => {
                    super::manifest::rename_with_retry(&part, &self.final_path)
                        .map_err(|e| map_io(e).info)?;
                    return Ok(size);
                }
                Err(e) if e.retry && attempt < self.retry_delays.len() => {
                    log::warn!("download attempt {} failed: {}", attempt + 1, e.info);
                    sleep_or_cancel(self.retry_delays[attempt], &self.cancel)
                        .await
                        .map_err(|e| e.info)?;
                    attempt += 1;
                }
                Err(e) => return Err(e.info),
            }
        }
    }

    fn report(&self, done: u64, total: Option<u64>) {
        self.progress.send_modify(|p| {
            p.bytes_done = done;
            if total.is_some() {
                p.bytes_total = total;
            }
        });
    }

    async fn attempt(&self, part: &std::path::Path) -> Result<u64, AttemptError> {
        let mut offset = file_len(part).await;
        let mut req = self
            .client
            .get(&self.url)
            .header(header::AUTHORIZATION, &self.auth_header);
        if offset > 0 {
            req = req.header(header::RANGE, format!("bytes={offset}-"));
        }
        let resp = tokio::select! {
            _ = self.cancel.cancelled() => return Err(AttemptError::cancelled()),
            r = tokio::time::timeout(self.read_timeout, req.send()) => match r {
                Err(_) => return Err(AttemptError::retry(ErrorCode::Network, "timed out waiting for the server")),
                Ok(r) => r.map_err(map_reqwest)?,
            },
        };

        let status = resp.status();
        let content_range = resp
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .map(parse_content_range);
        let content_length = resp.content_length();

        let total = match status {
            StatusCode::PARTIAL_CONTENT => {
                let (start, total) = content_range.unwrap_or((None, None));
                if start != Some(offset) {
                    truncate(part).await?;
                    return Err(AttemptError::retry(ErrorCode::Network, "server returned an unexpected range"));
                }
                total.or(content_length.map(|l| l + offset))
            }
            StatusCode::OK => {
                if offset > 0 {
                    // Server ignored Range: start over instead of appending a full body.
                    truncate(part).await?;
                    offset = 0;
                }
                content_length
            }
            StatusCode::RANGE_NOT_SATISFIABLE => {
                let server_total = content_range.and_then(|(_, t)| t);
                if offset > 0 && (server_total == Some(offset) || self.expected_bytes == Some(offset)) {
                    self.report(offset, Some(offset));
                    return Ok(offset);
                }
                truncate(part).await?;
                return Err(AttemptError::retry(ErrorCode::Network, "range not satisfiable"));
            }
            s if s.is_success() => content_length,
            s => return Err(map_status(s)),
        };
        let total = total.or(self.expected_bytes);
        self.report(offset, total);

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(part)
            .await
            .map_err(map_io)?;
        file.seek(std::io::SeekFrom::End(0)).await.map_err(map_io)?;
        let mut writer = BufWriter::with_capacity(1 << 20, file);
        let mut stream = resp.bytes_stream();
        let mut done = offset;

        loop {
            let next = tokio::select! {
                _ = self.cancel.cancelled() => {
                    let _ = writer.flush().await;
                    return Err(AttemptError::cancelled());
                }
                n = tokio::time::timeout(self.read_timeout, stream.next()) => n,
            };
            let chunk = match next {
                Err(_) => {
                    writer.flush().await.map_err(map_io)?;
                    return Err(AttemptError::retry(ErrorCode::Network, "read timed out"));
                }
                Ok(None) => break,
                Ok(Some(Err(e))) => {
                    writer.flush().await.map_err(map_io)?;
                    return Err(map_reqwest(e));
                }
                Ok(Some(Ok(c))) => c,
            };
            writer.write_all(&chunk).await.map_err(map_io)?;
            done += chunk.len() as u64;
            self.report(done, None);
        }
        writer.flush().await.map_err(map_io)?;
        writer.get_ref().sync_all().await.map_err(map_io)?;
        drop(writer);

        if let Some(expected) = total {
            if done != expected {
                if done > expected {
                    truncate(part).await?;
                }
                return Err(AttemptError::retry(
                    ErrorCode::Network,
                    format!("size mismatch: got {done} bytes, expected {expected}"),
                ));
            }
        }
        Ok(done)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use axum::{
        body::Body,
        extract::State,
        http::{HeaderMap, Response},
        routing::get,
        Router,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    pub fn payload() -> Vec<u8> {
        (0..300_000u32).map(|i| (i % 253) as u8).collect()
    }

    #[derive(Clone, Copy, PartialEq)]
    pub enum Behaviour {
        /// Honour Range.
        Normal,
        /// Drop the connection after N bytes on the first request only.
        DropFirstAfter(usize),
        /// Always answer 200 with the full body.
        IgnoreRange,
        NotFound,
        Unauthorized,
        /// Send fewer bytes than Content-Length announces on the first request.
        ShortFirst,
        /// Stream slowly (for cancel tests).
        Slow,
    }

    pub struct Srv {
        data: Vec<u8>,
        behaviour: Behaviour,
        pub hits: AtomicUsize,
    }

    async fn handler(State(s): State<Arc<Srv>>, headers: HeaderMap) -> Response<Body> {
        let hit = s.hits.fetch_add(1, Ordering::SeqCst);
        let len = s.data.len();
        match s.behaviour {
            Behaviour::NotFound => return Response::builder().status(404).body(Body::empty()).unwrap(),
            Behaviour::Unauthorized => return Response::builder().status(401).body(Body::empty()).unwrap(),
            _ => {}
        }
        let start = headers
            .get("range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("bytes="))
            .and_then(|v| v.trim_end_matches('-').parse::<usize>().ok())
            .filter(|_| s.behaviour != Behaviour::IgnoreRange);
        let (status, from) = match start {
            Some(st) if st >= len => {
                return Response::builder()
                    .status(416)
                    .header("content-range", format!("bytes */{len}"))
                    .body(Body::empty())
                    .unwrap()
            }
            Some(st) => (206, st),
            None => (200, 0),
        };
        let body = s.data[from..].to_vec();
        let mut b = Response::builder().status(status).header("content-length", body.len());
        if status == 206 {
            b = b.header("content-range", format!("bytes {from}-{}/{len}", len - 1));
        }
        let stream_body = match s.behaviour {
            Behaviour::DropFirstAfter(n) if hit == 0 => {
                let first = body[..n].to_vec();
                Body::from_stream(futures_util::stream::iter(vec![
                    Ok::<_, std::io::Error>(bytes::Bytes::from(first)),
                    Err(std::io::Error::other("connection reset")),
                ]))
            }
            Behaviour::ShortFirst if hit == 0 => {
                let first = body[..body.len() / 2].to_vec();
                Body::from_stream(futures_util::stream::iter(vec![
                    Ok::<_, std::io::Error>(bytes::Bytes::from(first)),
                    Err(std::io::Error::other("eof")),
                ]))
            }
            Behaviour::Slow => {
                let chunks: Vec<Vec<u8>> = body.chunks(1000).map(|c| c.to_vec()).collect();
                Body::from_stream(futures_util::stream::iter(chunks).then(|c| async move {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    Ok::<_, std::io::Error>(bytes::Bytes::from(c))
                }))
            }
            _ => Body::from(body),
        };
        b.body(stream_body).unwrap()
    }

    /// Start an in-process server; returns its URL and the hit counter.
    pub async fn start(behaviour: Behaviour, data: Vec<u8>) -> (String, Arc<Srv>) {
        let srv = Arc::new(Srv {
            data,
            behaviour,
            hits: AtomicUsize::new(0),
        });
        let app = Router::new().route("/file", get(handler)).with_state(srv.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/file"), srv)
    }

    fn job(url: String, dir: &std::path::Path) -> (FileJob, watch::Receiver<JobProgress>) {
        let (tx, rx) = watch::channel(JobProgress::default());
        (
            FileJob {
                client: reqwest::Client::new(),
                url,
                auth_header: "MediaBrowser Token=\"t\"".into(),
                final_path: dir.join("media.mkv"),
                expected_bytes: None,
                cancel: CancellationToken::new(),
                progress: tx,
                retry_delays: vec![Duration::from_millis(10); 3],
                read_timeout: Duration::from_secs(10),
            },
            rx,
        )
    }

    #[tokio::test]
    async fn fresh_download() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = start(Behaviour::Normal, payload()).await;
        let (j, rx) = job(url, tmp.path());
        assert_eq!(j.run().await.unwrap(), 300_000);
        assert_eq!(std::fs::read(tmp.path().join("media.mkv")).unwrap(), payload());
        assert!(!tmp.path().join("media.mkv.part").exists());
        assert_eq!(rx.borrow().bytes_done, 300_000);
        assert_eq!(rx.borrow().bytes_total, Some(300_000));
    }

    #[tokio::test]
    async fn resumes_after_dropped_connection() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, srv) = start(Behaviour::DropFirstAfter(100_000), payload()).await;
        let (j, _) = job(url, tmp.path());
        assert_eq!(j.run().await.unwrap(), 300_000);
        assert_eq!(std::fs::read(tmp.path().join("media.mkv")).unwrap(), payload());
        assert_eq!(srv.hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn resumes_existing_part_with_range() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("media.mkv.part"), &payload()[..12_345]).unwrap();
        let (url, srv) = start(Behaviour::Normal, payload()).await;
        let (j, _) = job(url, tmp.path());
        assert_eq!(j.run().await.unwrap(), 300_000);
        assert_eq!(std::fs::read(tmp.path().join("media.mkv")).unwrap(), payload());
        assert_eq!(srv.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn restarts_when_server_ignores_range() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("media.mkv.part"), vec![0xffu8; 5000]).unwrap();
        let (url, _) = start(Behaviour::IgnoreRange, payload()).await;
        let (j, _) = job(url, tmp.path());
        assert_eq!(j.run().await.unwrap(), 300_000);
        assert_eq!(std::fs::read(tmp.path().join("media.mkv")).unwrap(), payload());
    }

    #[tokio::test]
    async fn complete_part_with_416() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("media.mkv.part"), payload()).unwrap();
        let (url, _) = start(Behaviour::Normal, payload()).await;
        let (j, _) = job(url, tmp.path());
        assert_eq!(j.run().await.unwrap(), 300_000);
        assert!(tmp.path().join("media.mkv").exists());
    }

    #[tokio::test]
    async fn not_found_and_unauthorized() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, srv) = start(Behaviour::NotFound, payload()).await;
        let (j, _) = job(url, tmp.path());
        assert_eq!(j.run().await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(srv.hits.load(Ordering::SeqCst), 1, "404 must not be retried");

        let (url, _) = start(Behaviour::Unauthorized, payload()).await;
        let (j, _) = job(url, tmp.path());
        assert_eq!(j.run().await.unwrap_err().code, ErrorCode::Unauthorized);
    }

    #[tokio::test]
    async fn size_mismatch_is_retried() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, srv) = start(Behaviour::ShortFirst, payload()).await;
        let (j, _) = job(url, tmp.path());
        assert_eq!(j.run().await.unwrap(), 300_000);
        assert_eq!(std::fs::read(tmp.path().join("media.mkv")).unwrap(), payload());
        assert!(srv.hits.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn gives_up_after_retries() {
        let tmp = tempfile::tempdir().unwrap();
        // Nothing listens on this port.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        drop(listener);
        let (j, _) = job(url, tmp.path());
        assert_eq!(j.run().await.unwrap_err().code, ErrorCode::Network);
    }

    #[tokio::test]
    async fn cancel_keeps_part() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = start(Behaviour::Slow, payload()).await;
        let (j, rx) = job(url, tmp.path());
        let cancel = j.cancel.clone();
        let handle = tokio::spawn(async move { j.run().await });
        let mut rx = rx;
        while rx.borrow().bytes_done < 10_000 {
            rx.changed().await.unwrap();
        }
        cancel.cancel();
        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err.code, ErrorCode::Cancelled);
        let part = std::fs::metadata(tmp.path().join("media.mkv.part")).unwrap();
        assert!(part.len() >= 10_000 && part.len() < 300_000);
        assert!(!tmp.path().join("media.mkv").exists());
    }

    #[test]
    fn content_range_parsing() {
        assert_eq!(parse_content_range("bytes 100-199/1000"), (Some(100), Some(1000)));
        assert_eq!(parse_content_range("bytes */1000"), (None, Some(1000)));
        assert_eq!(parse_content_range("bytes 0-9/*"), (Some(0), None));
        assert_eq!(parse_content_range("junk"), (None, None));
    }
}
