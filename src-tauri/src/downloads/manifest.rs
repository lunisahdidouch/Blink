//! Atomic manifest.json read/write and startup scan.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::model::Manifest;
use super::paths;

pub const FILE_NAME: &str = "manifest.json";
const TMP_NAME: &str = "manifest.json.tmp";

pub fn read(item_dir: &Path) -> io::Result<Manifest> {
    let bytes = std::fs::read(item_dir.join(FILE_NAME))?;
    serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Write `manifest.json.tmp`, fsync it, then rename it over `manifest.json`.
pub fn write_atomic(item_dir: &Path, manifest: &Manifest) -> io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(item_dir)?;
    let tmp = item_dir.join(TMP_NAME);
    let data = serde_json::to_vec_pretty(manifest)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&data)?;
        f.sync_all()?;
    }
    rename_with_retry(&tmp, &item_dir.join(FILE_NAME))
}

/// `std::fs::rename` replaces the target on every platform; on Windows an AV scanner or the
/// indexer can briefly hold the file, so retry a few times.
pub fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut last = None;
    for attempt in 0..5 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(50 * (attempt + 1)));
            }
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("rename failed")))
}

/// Scan `{root}/*/*/manifest.json`. Corrupt or foreign entries are logged and skipped.
pub fn scan_all(root: &Path) -> Vec<(PathBuf, Manifest)> {
    let mut out = Vec::new();
    let Ok(servers) = std::fs::read_dir(root) else {
        return out;
    };
    for server in servers.flatten() {
        let server_name = server.file_name().to_string_lossy().to_string();
        if !server.path().is_dir() || !paths::is_valid_id(&server_name) {
            continue;
        }
        let Ok(items) = std::fs::read_dir(server.path()) else {
            continue;
        };
        for item in items.flatten() {
            let item_name = item.file_name().to_string_lossy().to_string();
            let dir = item.path();
            if !dir.is_dir() || !paths::is_valid_id(&item_name) {
                continue;
            }
            match read(&dir) {
                Ok(m) if m.server_id == server_name && m.item_id == item_name => out.push((dir, m)),
                Ok(_) => log::warn!("skipping {}: manifest ids don't match folder", dir.display()),
                Err(e) => log::warn!("skipping {}: {e}", dir.display()),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::downloads::model::*;

    pub fn sample(server: &str, item: &str) -> Manifest {
        Manifest {
            schema_version: SCHEMA_VERSION,
            id: format!("{server}:{item}"),
            server_id: server.into(),
            server_name: "Home".into(),
            server_address: "http://example".into(),
            user_id: "u1".into(),
            item_id: item.into(),
            media_source_id: item.into(),
            mode: Mode::File,
            media: MediaInfo {
                path: "media.mkv".into(),
                container: "mkv".into(),
                ..Default::default()
            },
            subtitles: vec![],
            images: Images::default(),
            item: serde_json::json!({"Id": item, "Name": "Ep", "SomeFutureField": {"x": [1, 2]}}),
            media_segments: serde_json::Value::Null,
            hls: None,
            status: Status::Completed,
            error: None,
            progress: Progress::default(),
            user_state: UserState::default(),
            created_at: now_rfc3339(),
            completed_at: None,
        }
    }

    #[test]
    fn round_trip_keeps_opaque_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let m = sample("aa", "bb");
        write_atomic(tmp.path(), &m).unwrap();
        assert!(!tmp.path().join(TMP_NAME).exists());
        let back = read(tmp.path()).unwrap();
        assert_eq!(back, m);
        assert_eq!(back.item["SomeFutureField"]["x"][1], 2);
        // camelCase on disk
        let raw = std::fs::read_to_string(tmp.path().join(FILE_NAME)).unwrap();
        assert!(raw.contains("\"mediaSourceId\""));
        assert!(raw.contains("\"userState\""));
    }

    #[test]
    fn scan_skips_corrupt_and_foreign() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_atomic(&root.join("aa").join("bb"), &sample("aa", "bb")).unwrap();
        let corrupt = root.join("aa").join("cc");
        std::fs::create_dir_all(&corrupt).unwrap();
        std::fs::write(corrupt.join(FILE_NAME), b"{ not json").unwrap();
        // ids that don't match the folder
        write_atomic(&root.join("aa").join("dd"), &sample("aa", "ee")).unwrap();
        // non-id folder names are ignored
        std::fs::create_dir_all(root.join("not an id").join("x")).unwrap();
        let found = scan_all(root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1.id, "aa:bb");
    }

    #[test]
    fn scan_of_missing_root_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan_all(&tmp.path().join("gone")).is_empty());
    }
}
