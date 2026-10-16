//! Small inline downloads (images, subtitles) with a size cap.

use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::file_job::{map_io, map_reqwest, map_status, part_path, AttemptError};
use super::model::{ErrorCode, ErrorInfo};

pub const MAX_ASSET_BYTES: u64 = 50 * 1024 * 1024;

/// Fetch `url` into `dest` unless it already exists and is non-empty.
pub async fn fetch_small(
    client: &reqwest::Client,
    url: &str,
    auth_header: &str,
    dest: &Path,
    cancel: &CancellationToken,
) -> Result<u64, ErrorInfo> {
    if let Ok(meta) = tokio::fs::metadata(dest).await {
        if meta.len() > 0 {
            return Ok(meta.len());
        }
    }
    fetch_inner(client, url, auth_header, dest, cancel, MAX_ASSET_BYTES)
        .await
        .map_err(|e| e.info)
}

async fn fetch_inner(
    client: &reqwest::Client,
    url: &str,
    auth_header: &str,
    dest: &Path,
    cancel: &CancellationToken,
    cap: u64,
) -> Result<u64, AttemptError> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(map_io)?;
    }
    let req = client
        .get(url)
        .header(header::AUTHORIZATION, auth_header)
        .timeout(Duration::from_secs(120));
    let resp = tokio::select! {
        _ = cancel.cancelled() => return Err(AttemptError::cancelled()),
        r = req.send() => r.map_err(map_reqwest)?,
    };
    if !resp.status().is_success() {
        return Err(map_status(resp.status()));
    }
    if resp.content_length().is_some_and(|l| l > cap) {
        return Err(AttemptError::fatal(ErrorCode::ServerRefused, "asset is too large"));
    }
    let tmp = part_path(dest);
    let mut file = tokio::fs::File::create(&tmp).await.map_err(map_io)?;
    let mut stream = resp.bytes_stream();
    let mut total = 0u64;
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(AttemptError::cancelled());
            }
            n = stream.next() => n,
        };
        match next {
            None => break,
            Some(Err(e)) => {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(map_reqwest(e));
            }
            Some(Ok(chunk)) => {
                total += chunk.len() as u64;
                if total > cap {
                    drop(file);
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return Err(AttemptError::fatal(ErrorCode::ServerRefused, "asset is too large"));
                }
                file.write_all(&chunk).await.map_err(map_io)?;
            }
        }
    }
    file.flush().await.map_err(map_io)?;
    drop(file);
    super::manifest::rename_with_retry(&tmp, dest).map_err(map_io)?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::downloads::file_job::tests::{start, Behaviour};

    #[tokio::test]
    async fn fetches_and_skips_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, srv) = start(Behaviour::Normal, b"WEBVTT\n".to_vec()).await;
        let dest = tmp.path().join("subs").join("3.vtt");
        let cancel = CancellationToken::new();
        let client = reqwest::Client::new();
        assert_eq!(fetch_small(&client, &url, "x", &dest, &cancel).await.unwrap(), 7);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "WEBVTT\n");
        fetch_small(&client, &url, "x", &dest, &cancel).await.unwrap();
        assert_eq!(srv.hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn enforces_cap_and_404() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = start(Behaviour::Normal, vec![1u8; 2048]).await;
        let dest = tmp.path().join("big.jpg");
        let cancel = CancellationToken::new();
        let client = reqwest::Client::new();
        let err = fetch_inner(&client, &url, "x", &dest, &cancel, 1024).await.unwrap_err();
        assert_eq!(err.info.code, ErrorCode::ServerRefused);
        assert!(!dest.exists());

        let (url, _) = start(Behaviour::NotFound, vec![]).await;
        let err = fetch_small(&client, &url, "x", &dest, &cancel).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
