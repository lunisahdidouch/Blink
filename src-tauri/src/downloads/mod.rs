//! Download manager: one media transfer at a time (FIFO), Rust is the only writer of
//! `manifest.json`, progress/status are pushed to the webview as events.

pub mod assets;
pub mod commands;
pub mod file_job;
pub mod hls_job;
pub mod manifest;
pub mod model;
pub mod paths;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{watch, Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::media_server::SharedRoot;
use file_job::{FileJob, JobProgress};
use hls_job::HlsJob;
use model::*;

pub const EVT_PROGRESS: &str = "downloads://progress";
pub const EVT_STATUS: &str = "downloads://status";
pub const EVT_REMOVED: &str = "downloads://removed";
pub const EVT_ROOT_CHANGED: &str = "downloads://root-changed";

/// Free space required on top of the expected size.
const SPACE_MARGIN: u64 = 200 * 1024 * 1024;

pub type EmitFn = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

fn err(code: ErrorCode, msg: impl Into<String>) -> ErrorInfo {
    ErrorInfo::new(code, msg)
}

fn io_err(e: std::io::Error) -> ErrorInfo {
    if file_job::is_disk_full(&e) {
        err(ErrorCode::DiskFull, "the disk is full")
    } else {
        err(ErrorCode::Io, e.to_string())
    }
}

struct ActiveJob {
    id: String,
    cancel: CancellationToken,
    done: watch::Receiver<bool>,
}

#[derive(Default)]
struct Inner {
    root: Option<PathBuf>,
    items: HashMap<String, Manifest>,
    /// Latest JobSpec per id (fresh URL + auth from TS). Never written to disk.
    jobs: HashMap<String, JobSpec>,
    queue: VecDeque<String>,
    active: Option<ActiveJob>,
}

struct NextJob {
    id: String,
    spec: JobSpec,
    manifest: Manifest,
    root: PathBuf,
    cancel: CancellationToken,
    done: watch::Sender<bool>,
}

pub struct Timing {
    pub file_retry_delays: Vec<Duration>,
    pub segment_retry_delays: Vec<Duration>,
    pub read_timeout: Duration,
    pub segment_timeout: Duration,
    pub progress_tick: Duration,
    pub persist_every: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            file_retry_delays: file_job::default_retry_delays(),
            segment_retry_delays: hls_job::default_segment_retry_delays(),
            read_timeout: Duration::from_secs(60),
            segment_timeout: Duration::from_secs(180),
            // at most 4 progress events per second per job
            progress_tick: Duration::from_millis(250),
            persist_every: Duration::from_secs(5),
        }
    }
}

pub struct DownloadManager {
    inner: Mutex<Inner>,
    shared_root: SharedRoot,
    media_base_url: String,
    emit: EmitFn,
    client: reqwest::Client,
    wake: Notify,
    worker_started: AtomicBool,
    timing: Timing,
}

impl DownloadManager {
    pub fn new(shared_root: SharedRoot, media_base_url: String, emit: EmitFn) -> Arc<Self> {
        Self::with_timing(shared_root, media_base_url, emit, Timing::default())
    }

    pub fn with_timing(
        shared_root: SharedRoot,
        media_base_url: String,
        emit: EmitFn,
        timing: Timing,
    ) -> Arc<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("Blink/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        Arc::new(Self {
            inner: Mutex::new(Inner::default()),
            shared_root,
            media_base_url,
            emit,
            client,
            wake: Notify::new(),
            worker_started: AtomicBool::new(false),
            timing,
        })
    }

    fn emit_json<T: serde::Serialize>(&self, event: &str, payload: &T) {
        if let Ok(v) = serde_json::to_value(payload) {
            (self.emit)(event, v);
        }
    }

    fn persist(&self, root: &Path, m: &Manifest) {
        let Some(dir) = paths::item_dir(root, &m.server_id, &m.item_id) else {
            return;
        };
        if let Err(e) = manifest::write_atomic(&dir, m) {
            log::error!("failed to write manifest for {}: {e}", m.id);
        }
    }

    fn info(&self, root: &Path) -> InitInfo {
        InitInfo {
            root: root.to_string_lossy().to_string(),
            media_base_url: self.media_base_url.clone(),
        }
    }

    fn set_shared_root(&self, root: Option<PathBuf>) {
        if let Ok(mut g) = self.shared_root.write() {
            *g = root;
        }
    }

    fn ensure_worker(self: &Arc<Self>) {
        if !self.worker_started.swap(true, Ordering::SeqCst) {
            let me = self.clone();
            tokio::spawn(async move { me.worker().await });
        }
    }

    /// Resolve the root, scan manifests and demote interrupted jobs to `paused`.
    /// Calling it again with the same root (e.g. after a webview reload) changes nothing.
    pub async fn init(self: &Arc<Self>, requested: PathBuf) -> Result<InitInfo, ErrorInfo> {
        let mut inner = self.inner.lock().await;
        if let Some(current) = inner.root.clone() {
            if current == requested || paths::resolve_root(&requested).ok().as_ref() == Some(&current) {
                paths::ensure_root(&current).map_err(io_err)?;
                self.ensure_worker();
                return Ok(self.info(&current));
            }
            if inner.active.is_some() {
                return Err(err(
                    ErrorCode::Io,
                    "a download is in progress; pause it before changing the folder",
                ));
            }
        }
        let root = paths::resolve_root(&requested).map_err(io_err)?;
        self.load_root(&mut inner, &root);
        self.ensure_worker();
        Ok(self.info(&root))
    }

    fn load_root(&self, inner: &mut Inner, root: &Path) {
        inner.items.clear();
        inner.queue.clear();
        for (_, mut m) in manifest::scan_all(root) {
            if matches!(m.status, Status::Downloading | Status::Queued) {
                m.status = Status::Paused;
                self.persist(root, &m);
            }
            inner.items.insert(m.id.clone(), m);
        }
        inner.root = Some(root.to_path_buf());
        self.set_shared_root(Some(root.to_path_buf()));
    }

    pub async fn list(&self) -> Vec<Manifest> {
        let inner = self.inner.lock().await;
        let mut v: Vec<Manifest> = inner.items.values().cloned().collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        v
    }

    pub async fn free_space(&self) -> Result<u64, ErrorInfo> {
        let root = self.inner.lock().await.root.clone();
        let root = root.ok_or_else(|| err(ErrorCode::Io, "downloads are not initialised"))?;
        fs4::available_space(&root).map_err(io_err)
    }

    /// Enqueue a new download, or resume a paused/failed one with a fresh URL and auth header.
    /// Idempotent per `"{serverId}:{itemId}"`; a completed item is a no-op.
    pub async fn enqueue(self: &Arc<Self>, job: JobSpec) -> Result<Manifest, ErrorInfo> {
        let m_in = &job.manifest;
        if !paths::is_valid_id(&m_in.server_id) || !paths::is_valid_id(&m_in.item_id) {
            return Err(err(ErrorCode::Unknown, "invalid server or item id"));
        }
        let id = paths::download_id(&m_in.server_id, &m_in.item_id);
        if m_in.id != id {
            return Err(err(ErrorCode::Unknown, "manifest id does not match serverId:itemId"));
        }
        let probe = Path::new("x");
        if paths::safe_join(probe, &m_in.media.path).is_none()
            || job.assets.iter().any(|a| paths::safe_join(probe, &a.rel_path).is_none())
        {
            return Err(err(ErrorCode::Unknown, "invalid relative path in job"));
        }

        let mut inner = self.inner.lock().await;
        let root = inner
            .root
            .clone()
            .ok_or_else(|| err(ErrorCode::Io, "downloads are not initialised"))?;

        let manifest = if let Some(existing) = inner.items.get(&id).cloned() {
            match existing.status {
                Status::Completed => return Ok(existing),
                Status::Downloading | Status::Queued => {
                    inner.jobs.insert(id.clone(), job);
                    return Ok(existing);
                }
                Status::Paused | Status::Failed => {
                    let mut m = job.manifest.clone();
                    m.schema_version = SCHEMA_VERSION;
                    m.created_at = existing.created_at.clone();
                    m.user_state = existing.user_state.clone();
                    m.completed_at = None;
                    m.progress = existing.progress.clone();
                    if existing.mode != m.mode || existing.media.path != m.media.path {
                        // Different kind of download now: drop the old partial data.
                        if let Some(dir) = paths::item_dir(&root, &m.server_id, &m.item_id) {
                            remove_media_data(&dir, &existing);
                        }
                        m.progress = Progress::default();
                    }
                    if m.progress.bytes_total.is_none() {
                        m.progress.bytes_total = job.expected_bytes;
                    }
                    m.status = Status::Queued;
                    m.error = None;
                    m
                }
            }
        } else {
            let available = fs4::available_space(&root).map_err(io_err)?;
            let needed = job
                .expected_bytes
                .map(|b| b + b / 20)
                .unwrap_or(0)
                .saturating_add(SPACE_MARGIN);
            if available < needed {
                return Err(err(
                    ErrorCode::InsufficientSpace,
                    format!(
                        "not enough free space: {} MB needed, {} MB available",
                        needed / 1_048_576,
                        available / 1_048_576
                    ),
                ));
            }
            let mut m = job.manifest.clone();
            m.schema_version = SCHEMA_VERSION;
            m.status = Status::Queued;
            m.error = None;
            m.completed_at = None;
            m.progress = Progress {
                bytes_total: job.expected_bytes,
                ..Default::default()
            };
            if m.created_at.is_empty() {
                m.created_at = now_rfc3339();
            }
            m
        };

        self.persist(&root, &manifest);
        inner.items.insert(id.clone(), manifest.clone());
        inner.jobs.insert(id.clone(), job);
        if !inner.queue.contains(&id) {
            inner.queue.push_back(id);
        }
        drop(inner);
        self.emit_json(EVT_STATUS, &manifest);
        self.ensure_worker();
        self.wake.notify_one();
        Ok(manifest)
    }

    pub async fn pause(&self, id: &str) -> Result<Manifest, ErrorInfo> {
        let mut inner = self.inner.lock().await;
        let root = inner.root.clone();
        let is_active = inner.active.as_ref().is_some_and(|a| a.id == id);
        let m = inner
            .items
            .get_mut(id)
            .ok_or_else(|| err(ErrorCode::NotFound, "unknown download"))?;
        match m.status {
            Status::Downloading | Status::Queued => {
                m.status = Status::Paused;
                let snapshot = m.clone();
                inner.queue.retain(|q| q != id);
                if is_active {
                    if let Some(a) = &inner.active {
                        a.cancel.cancel();
                    }
                }
                if let Some(root) = root {
                    self.persist(&root, &snapshot);
                }
                drop(inner);
                self.emit_json(EVT_STATUS, &snapshot);
                Ok(snapshot)
            }
            _ => Ok(m.clone()),
        }
    }

    /// Cancel (if active) and remove the item folder. `downloads_cancel` uses this as well:
    /// cancelling discards the partial data.
    pub async fn delete(&self, id: &str) -> Result<(), ErrorInfo> {
        let (server, item) =
            paths::parse_download_id(id).ok_or_else(|| err(ErrorCode::Unknown, "invalid download id"))?;
        let (root, wait) = {
            let mut inner = self.inner.lock().await;
            inner.items.remove(id);
            inner.jobs.remove(id);
            inner.queue.retain(|q| q != id);
            let wait = inner.active.as_ref().filter(|a| a.id == id).map(|a| {
                a.cancel.cancel();
                a.done.clone()
            });
            (inner.root.clone(), wait)
        };
        if let Some(mut done) = wait {
            let _ = tokio::time::timeout(Duration::from_secs(60), async {
                while !*done.borrow() {
                    if done.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
        }
        if let Some(root) = root {
            if let Some(dir) = paths::item_dir(&root, server, item) {
                remove_dir_with_retry(&dir).await.map_err(io_err)?;
                // Drop the server folder once it is empty.
                let _ = tokio::fs::remove_dir(root.join(server)).await;
            }
        }
        self.emit_json(EVT_REMOVED, &serde_json::json!({ "id": id }));
        Ok(())
    }

    pub async fn update_user_state(&self, id: &str, user_state: UserState) -> Result<Manifest, ErrorInfo> {
        let mut inner = self.inner.lock().await;
        let root = inner.root.clone();
        let m = inner
            .items
            .get_mut(id)
            .ok_or_else(|| err(ErrorCode::NotFound, "unknown download"))?;
        m.user_state = user_state;
        let snapshot = m.clone();
        if let Some(root) = root {
            self.persist(&root, &snapshot);
        }
        drop(inner);
        self.emit_json(EVT_STATUS, &snapshot);
        Ok(snapshot)
    }

    /// Move every server folder to `new_root`. Refused while a transfer is running.
    pub async fn move_root(self: &Arc<Self>, new_root: PathBuf) -> Result<InitInfo, ErrorInfo> {
        let mut inner = self.inner.lock().await;
        if inner.active.is_some() || inner.items.values().any(|m| m.status == Status::Downloading) {
            return Err(err(
                ErrorCode::Io,
                "pause active downloads before changing the folder",
            ));
        }
        let old = inner
            .root
            .clone()
            .ok_or_else(|| err(ErrorCode::Io, "downloads are not initialised"))?;
        let new = paths::resolve_root(&new_root).map_err(io_err)?;
        if new == old {
            return Ok(self.info(&old));
        }
        if new.starts_with(&old) {
            return Err(err(ErrorCode::Io, "the new folder is inside the current one"));
        }
        // Queued items become paused; their job specs stay valid (paths are derived from the root).
        let queued: Vec<String> = inner.queue.drain(..).collect();
        for id in queued {
            if let Some(m) = inner.items.get_mut(&id) {
                m.status = Status::Paused;
                let snapshot = m.clone();
                self.persist(&old, &snapshot);
            }
        }
        let (o, n) = (old.clone(), new.clone());
        tokio::task::spawn_blocking(move || move_tree(&o, &n))
            .await
            .map_err(|e| err(ErrorCode::Io, e.to_string()))?
            .map_err(io_err)?;
        self.load_root(&mut inner, &new);
        drop(inner);
        let info = self.info(&new);
        self.emit_json(EVT_ROOT_CHANGED, &info);
        Ok(info)
    }

    pub async fn item_folder(&self, id: Option<&str>) -> Result<PathBuf, ErrorInfo> {
        let root = self
            .inner
            .lock()
            .await
            .root
            .clone()
            .ok_or_else(|| err(ErrorCode::Io, "downloads are not initialised"))?;
        match id {
            None => Ok(root),
            Some(id) => {
                let (s, i) =
                    paths::parse_download_id(id).ok_or_else(|| err(ErrorCode::Unknown, "invalid download id"))?;
                paths::item_dir(&root, s, i).ok_or_else(|| err(ErrorCode::Unknown, "invalid download id"))
            }
        }
    }

    // ---- worker ----

    async fn worker(self: Arc<Self>) {
        loop {
            match self.take_next().await {
                Some(next) => self.run(next).await,
                None => self.wake.notified().await,
            }
        }
    }

    async fn take_next(&self) -> Option<NextJob> {
        let mut inner = self.inner.lock().await;
        if inner.active.is_some() {
            return None;
        }
        let root = inner.root.clone()?;
        while let Some(id) = inner.queue.pop_front() {
            let queued = inner.items.get(&id).is_some_and(|m| m.status == Status::Queued);
            let Some(spec) = inner.jobs.get(&id).cloned() else {
                continue;
            };
            if !queued {
                continue;
            }
            let cancel = CancellationToken::new();
            let (done_tx, done_rx) = watch::channel(false);
            inner.active = Some(ActiveJob {
                id: id.clone(),
                cancel: cancel.clone(),
                done: done_rx,
            });
            let m = inner.items.get_mut(&id)?;
            m.status = Status::Downloading;
            m.error = None;
            let snapshot = m.clone();
            self.persist(&root, &snapshot);
            drop(inner);
            self.emit_json(EVT_STATUS, &snapshot);
            return Some(NextJob {
                id,
                spec,
                manifest: snapshot,
                root,
                cancel,
                done: done_tx,
            });
        }
        None
    }

    async fn run(self: &Arc<Self>, next: NextJob) {
        let NextJob {
            id,
            spec,
            manifest: m,
            root,
            cancel,
            done,
        } = next;
        let Some(item_dir) = paths::item_dir(&root, &m.server_id, &m.item_id) else {
            return;
        };
        let (ptx, prx) = watch::channel(JobProgress {
            bytes_done: m.progress.bytes_done,
            bytes_total: m.progress.bytes_total.or(spec.expected_bytes),
            segments_done: m.progress.segments_done,
            segments_total: m.progress.segments_total,
        });
        let stop_reporter = CancellationToken::new();
        let reporter = tokio::spawn(self.clone().report_loop(
            id.clone(),
            root.clone(),
            prx.clone(),
            stop_reporter.clone(),
        ));

        let result = self.execute(&spec, &m, &item_dir, &cancel, ptx).await;

        stop_reporter.cancel();
        let _ = reporter.await;
        if m.mode == Mode::Hls {
            self.stop_transcode(&spec, &m).await;
        }

        let latest = *prx.borrow();
        let mut inner = self.inner.lock().await;
        if inner.active.as_ref().is_some_and(|a| a.id == id) {
            inner.active = None;
        }
        let mut emit_snapshot = None;
        if let Some(cur) = inner.items.get_mut(&id) {
            cur.progress = Progress {
                bytes_done: latest.bytes_done,
                bytes_total: latest.bytes_total,
                segments_done: latest.segments_done,
                segments_total: latest.segments_total,
            };
            reconcile_assets(&item_dir, cur);
            match &result {
                Ok((bytes, segments)) => {
                    cur.status = Status::Completed;
                    cur.error = None;
                    cur.completed_at = Some(now_rfc3339());
                    cur.media.size_bytes = Some(*bytes);
                    cur.progress.bytes_done = *bytes;
                    cur.progress.bytes_total = Some(*bytes);
                    if let (Some(hls), Some(n)) = (cur.hls.as_mut(), segments) {
                        hls.segment_count = Some(*n);
                    }
                }
                Err(e) if e.code == ErrorCode::Cancelled => {
                    if cur.status == Status::Downloading {
                        cur.status = Status::Paused;
                    }
                }
                Err(e) => {
                    cur.status = Status::Failed;
                    cur.error = Some(e.clone());
                }
            }
            let snapshot = cur.clone();
            self.persist(&root, &snapshot);
            emit_snapshot = Some(snapshot);
        }
        if result.is_ok() {
            inner.jobs.remove(&id);
        }
        drop(inner);
        if let Some(s) = emit_snapshot {
            self.emit_json(EVT_STATUS, &s);
        }
        let _ = done.send(true);
    }

    async fn execute(
        &self,
        spec: &JobSpec,
        m: &Manifest,
        item_dir: &Path,
        cancel: &CancellationToken,
        progress: watch::Sender<JobProgress>,
    ) -> Result<(u64, Option<u32>), ErrorInfo> {
        tokio::fs::create_dir_all(item_dir).await.map_err(io_err)?;
        for asset in &spec.assets {
            if cancel.is_cancelled() {
                return Err(err(ErrorCode::Cancelled, "cancelled"));
            }
            let Some(dest) = paths::safe_join(item_dir, &asset.rel_path) else {
                continue;
            };
            if let Err(e) =
                assets::fetch_small(&self.client, &asset.url, &spec.auth_header, &dest, cancel).await
            {
                match e.code {
                    ErrorCode::Cancelled | ErrorCode::Unauthorized | ErrorCode::DiskFull => return Err(e),
                    _ => log::warn!("asset {} skipped: {e}", asset.rel_path),
                }
            }
        }
        match m.mode {
            Mode::File => {
                let final_path = paths::safe_join(item_dir, &m.media.path)
                    .ok_or_else(|| err(ErrorCode::Unknown, "invalid media path"))?;
                let job = FileJob {
                    client: self.client.clone(),
                    url: spec.media_url.clone(),
                    auth_header: spec.auth_header.clone(),
                    final_path,
                    expected_bytes: spec.expected_bytes,
                    cancel: cancel.clone(),
                    progress,
                    retry_delays: self.timing.file_retry_delays.clone(),
                    read_timeout: self.timing.read_timeout,
                };
                job.run().await.map(|b| (b, None))
            }
            Mode::Hls => {
                let job = HlsJob {
                    client: self.client.clone(),
                    master_url: spec.media_url.clone(),
                    auth_header: spec.auth_header.clone(),
                    dir: item_dir.to_path_buf(),
                    cancel: cancel.clone(),
                    progress,
                    start_segments_done: m.progress.segments_done.unwrap_or(0),
                    segment_timeout: self.timing.segment_timeout,
                    retry_delays: self.timing.segment_retry_delays.clone(),
                };
                job.run().await.map(|o| (o.bytes, Some(o.segments)))
            }
        }
    }

    /// Sample job progress: emit at most every `progress_tick`, persist every `persist_every`.
    async fn report_loop(
        self: Arc<Self>,
        id: String,
        root: PathBuf,
        mut rx: watch::Receiver<JobProgress>,
        stop: CancellationToken,
    ) {
        let mut tick = tokio::time::interval(self.timing.progress_tick);
        let mut last_bytes = rx.borrow().bytes_done;
        let mut last_at = Instant::now();
        let mut last_persist = Instant::now();
        let mut speed = 0f64;
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = tick.tick() => {}
            }
            let changed = rx.has_changed().unwrap_or(false);
            let p = *rx.borrow_and_update();
            let elapsed = last_at.elapsed().as_secs_f64().max(0.001);
            let instant = p.bytes_done.saturating_sub(last_bytes) as f64 / elapsed;
            speed = if speed == 0.0 { instant } else { speed * 0.7 + instant * 0.3 };
            last_bytes = p.bytes_done;
            last_at = Instant::now();
            if !changed && instant == 0.0 && speed < 1.0 {
                continue;
            }
            self.emit_json(
                EVT_PROGRESS,
                &ProgressEvent {
                    id: id.clone(),
                    bytes_done: p.bytes_done,
                    bytes_total: p.bytes_total,
                    segments_done: p.segments_done,
                    segments_total: p.segments_total,
                    speed_bps: speed as u64,
                },
            );
            if last_persist.elapsed() >= self.timing.persist_every {
                last_persist = Instant::now();
                let mut inner = self.inner.lock().await;
                if let Some(m) = inner.items.get_mut(&id) {
                    if m.status == Status::Downloading {
                        m.progress = Progress {
                            bytes_done: p.bytes_done,
                            bytes_total: p.bytes_total,
                            segments_done: p.segments_done,
                            segments_total: p.segments_total,
                        };
                        let snapshot = m.clone();
                        self.persist(&root, &snapshot);
                    }
                }
            }
        }
    }

    /// Best-effort `DELETE /Videos/ActiveEncodings` so the server stops transcoding.
    async fn stop_transcode(&self, spec: &JobSpec, m: &Manifest) {
        let (Some(base), Some(device), Some(session)) = (
            spec.base_path.as_deref(),
            spec.device_id.as_deref(),
            m.hls.as_ref().and_then(|h| h.play_session_id.as_deref()),
        ) else {
            return;
        };
        let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        let url = format!(
            "{}/Videos/ActiveEncodings?deviceId={}&playSessionId={}",
            base.trim_end_matches('/'),
            enc(device),
            enc(session)
        );
        let req = self
            .client
            .delete(url)
            .header(reqwest::header::AUTHORIZATION, &spec.auth_header)
            .timeout(Duration::from_secs(5))
            .send();
        if let Err(e) = req.await {
            log::debug!("ActiveEncodings cleanup failed: {e}");
        }
    }
}

/// Drop subtitle/image paths whose files didn't make it to disk.
fn reconcile_assets(item_dir: &Path, m: &mut Manifest) {
    let exists = |rel: &str| {
        paths::safe_join(item_dir, rel)
            .and_then(|p| std::fs::metadata(p).ok())
            .is_some_and(|md| md.len() > 0)
    };
    for s in &mut m.subtitles {
        if let Some(p) = &s.path {
            if !exists(p) {
                s.path = None;
                s.unavailable = true;
            }
        }
    }
    for img in [
        &mut m.images.primary,
        &mut m.images.series_primary,
        &mut m.images.backdrop,
    ] {
        if img.as_deref().is_some_and(|p| !exists(p)) {
            *img = None;
        }
    }
}

fn remove_media_data(item_dir: &Path, m: &Manifest) {
    if let Some(p) = paths::safe_join(item_dir, &m.media.path) {
        let _ = std::fs::remove_file(file_job::part_path(&p));
        let _ = std::fs::remove_file(&p);
    }
    let _ = std::fs::remove_dir_all(item_dir.join("hls"));
}

/// `remove_dir_all`, retried 3× with 500 ms waits (Windows AV/indexer locks).
async fn remove_dir_with_retry(dir: &Path) -> std::io::Result<()> {
    let mut last = None;
    for _ in 0..4 {
        match tokio::fs::remove_dir_all(dir).await {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("remove failed")))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Rename, or copy + delete when the rename fails (e.g. across drives).
fn move_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_dir(from, to)?;
    std::fs::remove_dir_all(from)
}

/// Move `{old}/{serverId}/{itemId}` folders into `new`, merging with existing server folders.
fn move_tree(old: &Path, new: &Path) -> std::io::Result<()> {
    let Ok(servers) = std::fs::read_dir(old) else {
        return Ok(());
    };
    for server in servers.flatten() {
        let name = server.file_name().to_string_lossy().to_string();
        if !server.path().is_dir() || !paths::is_valid_id(&name) {
            continue;
        }
        let target = new.join(&name);
        if !target.exists() {
            move_dir(&server.path(), &target)?;
            continue;
        }
        for item in std::fs::read_dir(server.path())?.flatten() {
            let item_target = target.join(item.file_name());
            if item_target.exists() {
                log::warn!("{} already exists; leaving the old copy", item_target.display());
                continue;
            }
            move_dir(&item.path(), &item_target)?;
        }
        let _ = std::fs::remove_dir(server.path());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::downloads::file_job::tests::{payload, start, Behaviour};
    use std::sync::RwLock;

    fn manager() -> (Arc<DownloadManager>, Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>) {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev = events.clone();
        let emit: EmitFn = Arc::new(move |name, v| ev.lock().unwrap().push((name.to_string(), v)));
        let timing = Timing {
            file_retry_delays: vec![Duration::from_millis(10); 2],
            segment_retry_delays: vec![Duration::from_millis(10); 2],
            read_timeout: Duration::from_secs(10),
            segment_timeout: Duration::from_secs(10),
            progress_tick: Duration::from_millis(20),
            persist_every: Duration::from_millis(50),
        };
        let root: SharedRoot = Arc::new(RwLock::new(None));
        (DownloadManager::with_timing(root, "http://127.0.0.1:1/t".into(), emit, timing), events)
    }

    fn job(url: &str, item: &str) -> JobSpec {
        JobSpec {
            manifest: Manifest {
                schema_version: 1,
                id: format!("aa:{item}"),
                server_id: "aa".into(),
                server_name: "Home".into(),
                server_address: "http://x".into(),
                user_id: "u".into(),
                item_id: item.into(),
                media_source_id: item.into(),
                mode: Mode::File,
                media: MediaInfo {
                    path: "media.mkv".into(),
                    container: "mkv".into(),
                    ..Default::default()
                },
                subtitles: vec![SubtitleInfo {
                    stream_index: 3,
                    codec: "subrip".into(),
                    path: Some("subs/3.vtt".into()),
                    ..Default::default()
                }],
                images: Images::default(),
                item: serde_json::json!({ "Id": item }),
                media_segments: serde_json::Value::Null,
                hls: None,
                status: Status::Queued,
                error: None,
                progress: Progress::default(),
                user_state: UserState::default(),
                created_at: String::new(),
                completed_at: None,
            },
            auth_header: "MediaBrowser Token=\"t\"".into(),
            media_url: url.into(),
            // The subtitle URL 404s, so it must end up unavailable.
            assets: vec![AssetSpec {
                url: format!("{url}/missing"),
                rel_path: "subs/3.vtt".into(),
            }],
            expected_bytes: Some(300_000),
            base_path: None,
            device_id: None,
        }
    }

    async fn wait_status(mgr: &DownloadManager, id: &str, status: Status) -> Manifest {
        for _ in 0..500 {
            if let Some(m) = mgr.list().await.into_iter().find(|m| m.id == id) {
                if m.status == status {
                    return m;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{id} never reached {status:?}");
    }

    #[tokio::test]
    async fn enqueue_runs_to_completion() {
        let tmp = tempfile::tempdir().unwrap();
        let (mgr, events) = manager();
        mgr.init(tmp.path().join("dl")).await.unwrap();
        let (url, _) = start(Behaviour::Normal, payload()).await;
        mgr.enqueue(job(&url, "bb")).await.unwrap();
        let m = wait_status(&mgr, "aa:bb", Status::Completed).await;
        assert_eq!(m.media.size_bytes, Some(300_000));
        assert!(m.subtitles[0].unavailable);
        assert!(m.subtitles[0].path.is_none());
        let on_disk = manifest::read(&tmp.path().join("dl/aa/bb")).unwrap();
        assert_eq!(on_disk.status, Status::Completed);
        assert!(!serde_json::to_string(&on_disk).unwrap().contains("Token"));
        // Re-enqueueing a completed item is a no-op.
        assert_eq!(mgr.enqueue(job(&url, "bb")).await.unwrap().status, Status::Completed);
        assert!(events.lock().unwrap().iter().any(|(n, _)| n == EVT_STATUS));
    }

    #[tokio::test]
    async fn init_demotes_interrupted_jobs_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("dl");
        let mut m = job("http://x", "cc").manifest;
        m.status = Status::Downloading;
        paths::resolve_root(&root).unwrap();
        manifest::write_atomic(&root.join("aa").join("cc"), &m).unwrap();
        let (mgr, _) = manager();
        mgr.init(root.clone()).await.unwrap();
        assert_eq!(mgr.list().await[0].status, Status::Paused);
        assert_eq!(manifest::read(&root.join("aa/cc")).unwrap().status, Status::Paused);
        let info = mgr.init(root.clone()).await.unwrap();
        assert_eq!(info.root, root.to_string_lossy());
        assert_eq!(mgr.list().await.len(), 1);
    }

    #[tokio::test]
    async fn pause_resume_and_delete_while_downloading() {
        let tmp = tempfile::tempdir().unwrap();
        let (mgr, _) = manager();
        mgr.init(tmp.path().join("dl")).await.unwrap();
        let (url, _) = start(Behaviour::Slow, payload()).await;
        mgr.enqueue(job(&url, "dd")).await.unwrap();
        wait_status(&mgr, "aa:dd", Status::Downloading).await;
        // Wait for real progress (the worker may be slow to start under parallel tests).
        let part = tmp.path().join("dl/aa/dd/media.mkv.part");
        for _ in 0..500 {
            if part.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        mgr.pause("aa:dd").await.unwrap();
        // Let the worker see the cancel and write its final progress.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let paused = wait_status(&mgr, "aa:dd", Status::Paused).await;
        assert!(part.exists());
        assert!(paused.progress.bytes_done > 0);

        mgr.enqueue(job(&url, "dd")).await.unwrap();
        wait_status(&mgr, "aa:dd", Status::Downloading).await;
        mgr.delete("aa:dd").await.unwrap();
        assert!(!tmp.path().join("dl/aa/dd").exists());
        assert!(mgr.list().await.is_empty());
    }

    #[tokio::test]
    async fn failed_download_reports_code() {
        let tmp = tempfile::tempdir().unwrap();
        let (mgr, _) = manager();
        mgr.init(tmp.path().join("dl")).await.unwrap();
        let (url, _) = start(Behaviour::NotFound, vec![]).await;
        mgr.enqueue(job(&url, "ee")).await.unwrap();
        let m = wait_status(&mgr, "aa:ee", Status::Failed).await;
        assert_eq!(m.error.unwrap().code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn move_root_moves_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let (mgr, _) = manager();
        mgr.init(tmp.path().join("one")).await.unwrap();
        let (url, _) = start(Behaviour::Normal, payload()).await;
        mgr.enqueue(job(&url, "ff")).await.unwrap();
        wait_status(&mgr, "aa:ff", Status::Completed).await;
        let info = mgr.move_root(tmp.path().join("two")).await.unwrap();
        assert!(info.root.ends_with("two"));
        assert!(tmp.path().join("two/aa/ff/media.mkv").exists());
        assert!(!tmp.path().join("one/aa/ff").exists());
        assert_eq!(mgr.list().await[0].status, Status::Completed);
    }
}
