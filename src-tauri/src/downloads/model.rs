//! Data model shared with the TypeScript side (`src/utils/downloads/types.ts`).
//! Every struct is serialised in camelCase; keep both files in sync.

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Queued,
    Downloading,
    Paused,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    File,
    Hls,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Network,
    Unauthorized,
    NotFound,
    DiskFull,
    InsufficientSpace,
    ServerRefused,
    Io,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo {
    pub code: ErrorCode,
    pub message: String,
}

impl ErrorInfo {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ErrorInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ErrorInfo {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Progress {
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub segments_done: Option<u32>,
    pub segments_total: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UserState {
    pub position_ticks: i64,
    pub played: bool,
    /// RFC3339
    pub last_played_at: Option<String>,
    pub pending_sync: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaInfo {
    /// Relative to the item folder, e.g. `media.mkv` or `hls/index.m3u8`.
    pub path: String,
    pub container: String,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate: Option<u64>,
    pub audio_stream_index: Option<i32>,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SubtitleInfo {
    pub stream_index: i32,
    pub codec: String,
    pub language: Option<String>,
    pub display_title: Option<String>,
    pub is_default: bool,
    pub is_forced: bool,
    /// Relative path (`subs/{index}.{ext}`) once downloaded.
    pub path: Option<String>,
    pub unavailable: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Images {
    pub primary: Option<String>,
    pub series_primary: Option<String>,
    pub backdrop: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HlsInfo {
    pub quality: String,
    pub max_bitrate: Option<u64>,
    pub segment_count: Option<u32>,
    pub play_session_id: Option<String>,
}

fn default_schema() -> u32 {
    SCHEMA_VERSION
}

fn default_status() -> Status {
    Status::Queued
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default = "default_schema")]
    pub schema_version: u32,
    /// `"{serverId}:{itemId}"`
    pub id: String,
    pub server_id: String,
    #[serde(default)]
    pub server_name: String,
    #[serde(default)]
    pub server_address: String,
    #[serde(default)]
    pub user_id: String,
    pub item_id: String,
    #[serde(default)]
    pub media_source_id: String,
    pub mode: Mode,
    #[serde(default)]
    pub media: MediaInfo,
    #[serde(default)]
    pub subtitles: Vec<SubtitleInfo>,
    #[serde(default)]
    pub images: Images,
    /// Trimmed BaseItemDto; opaque to Rust.
    #[serde(default)]
    pub item: serde_json::Value,
    /// MediaSegmentDtoQueryResult or null; opaque to Rust.
    #[serde(default)]
    pub media_segments: serde_json::Value,
    #[serde(default)]
    pub hls: Option<HlsInfo>,
    #[serde(default = "default_status")]
    pub status: Status,
    #[serde(default)]
    pub error: Option<ErrorInfo>,
    #[serde(default)]
    pub progress: Progress,
    #[serde(default)]
    pub user_state: UserState,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSpec {
    pub url: String,
    /// Relative to the item folder, e.g. `subs/3.vtt` or `images/primary.jpg`.
    pub rel_path: String,
}

/// What TS sends to `downloads_enqueue` / `downloads_resume`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    /// `status`, `progress`, `error` and `userState` are ignored on input.
    pub manifest: Manifest,
    /// Value of `api.authorizationHeader`. Never persisted.
    pub auth_header: String,
    /// file: `{basePath}/Items/{id}/Download?mediaSourceId=…`; hls: absolute master.m3u8 URL.
    pub media_url: String,
    #[serde(default)]
    pub assets: Vec<AssetSpec>,
    #[serde(default)]
    pub expected_bytes: Option<u64>,
    /// Used for the best-effort `DELETE /Videos/ActiveEncodings` after an HLS job.
    #[serde(default)]
    pub base_path: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub id: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub segments_done: Option<u32>,
    pub segments_total: Option<u32>,
    pub speed_bps: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitInfo {
    pub root: String,
    pub media_base_url: String,
}

/// Format the current time as RFC3339 (UTC, second precision) without pulling in chrono.
pub fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_rfc3339(secs)
}

pub fn format_rfc3339(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let rem = unix_secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_formatting() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(format_rfc3339(1_791_234_567), "2026-10-05T21:09:27Z");
    }

    #[test]
    fn enums_are_camel_case() {
        assert_eq!(
            serde_json::to_string(&ErrorCode::InsufficientSpace).unwrap(),
            "\"insufficientSpace\""
        );
        assert_eq!(serde_json::to_string(&Status::Downloading).unwrap(), "\"downloading\"");
        assert_eq!(serde_json::to_string(&Mode::Hls).unwrap(), "\"hls\"");
    }
}
