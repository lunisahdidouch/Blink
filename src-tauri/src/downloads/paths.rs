//! Root handling, id validation and safe path joining for the downloads folder.

use std::io;
use std::path::{Path, PathBuf};

/// Marker file that identifies a folder as a Blink downloads root.
pub const MARKER: &str = ".blink-downloads";
/// Subfolder used when the user picks a non-empty folder that isn't ours.
pub const SUBFOLDER: &str = "Blink Downloads";
const MARKER_CONTENT: &str = "1\n";

/// Jellyfin GUIDs: hex digits and dashes, 1..=64 chars.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub fn download_id(server_id: &str, item_id: &str) -> String {
    format!("{server_id}:{item_id}")
}

/// Split `"{serverId}:{itemId}"` and validate both halves.
pub fn parse_download_id(id: &str) -> Option<(&str, &str)> {
    let (server, item) = id.split_once(':')?;
    (is_valid_id(server) && is_valid_id(item)).then_some((server, item))
}

pub fn item_dir(root: &Path, server_id: &str, item_id: &str) -> Option<PathBuf> {
    (is_valid_id(server_id) && is_valid_id(item_id)).then(|| root.join(server_id).join(item_id))
}

/// Join a `/`-separated relative path onto `root`, rejecting anything that could escape it:
/// empty segments, `.`/`..`, backslashes, drive letters/ADS (`:`), NUL and absolute/UNC paths.
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') || rel.contains('\0') {
        return None;
    }
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains(':') {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

fn is_dir_empty(path: &Path) -> io::Result<bool> {
    Ok(std::fs::read_dir(path)?.next().is_none())
}

fn write_marker(path: &Path) -> io::Result<()> {
    std::fs::write(path.join(MARKER), MARKER_CONTENT)
}

/// Turn a candidate folder into a usable downloads root:
/// - missing → create it and write the marker
/// - has the marker → use it
/// - exists but empty → write the marker
/// - non-empty and not ours → use (and create) `{candidate}/Blink Downloads`
pub fn resolve_root(candidate: &Path) -> io::Result<PathBuf> {
    if !candidate.exists() {
        std::fs::create_dir_all(candidate)?;
        write_marker(candidate)?;
        return Ok(candidate.to_path_buf());
    }
    if !candidate.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "download location is not a folder",
        ));
    }
    if candidate.join(MARKER).is_file() {
        return Ok(candidate.to_path_buf());
    }
    if is_dir_empty(candidate)? {
        write_marker(candidate)?;
        return Ok(candidate.to_path_buf());
    }
    let sub = candidate.join(SUBFOLDER);
    if !sub.exists() {
        std::fs::create_dir_all(&sub)?;
        write_marker(&sub)?;
        return Ok(sub);
    }
    if sub.join(MARKER).is_file() || is_dir_empty(&sub)? {
        write_marker(&sub)?;
        return Ok(sub);
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("{} exists and is not a Blink downloads folder", sub.display()),
    ))
}

/// Make sure an existing root still has its folder and marker (it may have been deleted externally).
pub fn ensure_root(root: &Path) -> io::Result<()> {
    std::fs::create_dir_all(root)?;
    if !root.join(MARKER).is_file() {
        write_marker(root)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_validation() {
        assert!(is_valid_id("90872953c7f7c387676626c8deaaba5b"));
        assert!(is_valid_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("../etc"));
        assert!(!is_valid_id("abc/def"));
        assert!(!is_valid_id("zz"));
        assert!(!is_valid_id(&"a".repeat(65)));
        assert_eq!(parse_download_id("ab:cd"), Some(("ab", "cd")));
        assert_eq!(parse_download_id("ab"), None);
        assert_eq!(parse_download_id("ab:c/d"), None);
    }

    #[test]
    fn safe_join_rejects_escapes() {
        let root = Path::new("root");
        assert_eq!(safe_join(root, "a/b.mkv"), Some(root.join("a").join("b.mkv")));
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../../x",
            "a/./b",
            "a//b",
            "a\\b",
            "C:/x",
            "c:x",
            "\\\\server\\share",
            "a/b:stream",
            "a\0b",
        ] {
            assert_eq!(safe_join(root, bad), None, "{bad:?} should be rejected");
        }
    }

    #[test]
    fn resolve_root_rules() {
        let tmp = tempfile::tempdir().unwrap();
        // missing → created with marker
        let fresh = tmp.path().join("new");
        assert_eq!(resolve_root(&fresh).unwrap(), fresh);
        assert!(fresh.join(MARKER).is_file());
        // ours → reused
        assert_eq!(resolve_root(&fresh).unwrap(), fresh);
        // empty → adopted
        let empty = tmp.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        assert_eq!(resolve_root(&empty).unwrap(), empty);
        // foreign non-empty → subfolder
        let foreign = tmp.path().join("foreign");
        std::fs::create_dir(&foreign).unwrap();
        std::fs::write(foreign.join("holiday.jpg"), b"x").unwrap();
        let resolved = resolve_root(&foreign).unwrap();
        assert_eq!(resolved, foreign.join(SUBFOLDER));
        assert!(resolved.join(MARKER).is_file());
        assert!(!foreign.join(MARKER).exists());
    }
}
