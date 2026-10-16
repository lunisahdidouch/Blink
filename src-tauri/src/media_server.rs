//! Loopback HTTP server that serves downloaded media to the webview.
//!
//! `http://127.0.0.1:{port}/{token}/{serverId}/{itemId}/...` → file under the downloads root.
//! Range/206 and conditional requests are handled by `tower_http::services::ServeFile`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use axum::{
    body::Body,
    extract::{Path as UrlPath, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use rand::Rng;
use tower::ServiceExt;
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeFile,
};

use crate::downloads::paths;

/// Downloads root shared with the download manager (`None` until `downloads_init`).
pub type SharedRoot = Arc<RwLock<Option<PathBuf>>>;

#[derive(Debug, Clone)]
pub struct MediaServerHandle {
    pub port: u16,
    pub token: String,
}

impl MediaServerHandle {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.token)
    }
}

struct ServerState {
    root: SharedRoot,
    token: String,
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// MIME overrides from the plan (D4). Anything else keeps ServeFile's guess.
pub fn mime_override(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "m3u8" => "application/vnd.apple.mpegurl",
        "ts" => "video/mp2t",
        "mkv" => "video/x-matroska",
        "mp4" | "m4v" => "video/mp4",
        "m4s" => "video/iso.segment",
        "webm" => "video/webm",
        "vtt" => "text/vtt",
        "ass" | "ssa" => "text/plain; charset=utf-8",
        "sup" => "application/octet-stream",
        "jpg" | "jpeg" => "image/jpeg",
        _ => return None,
    })
}

async fn serve(
    State(state): State<Arc<ServerState>>,
    UrlPath((token, rel)): UrlPath<(String, String)>,
    req: Request,
) -> Response {
    if !constant_time_eq(token.as_bytes(), state.token.as_bytes()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let root = state.root.read().ok().and_then(|g| g.clone());
    let Some(root) = root else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(path) = paths::safe_join(&root, &rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !path.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mime = mime_override(&path);
    match ServeFile::new(&path).oneshot(req).await {
        Ok(res) => {
            let mut res = res.map(Body::new);
            if let Some(mime) = mime {
                res.headers_mut()
                    .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            }
            res
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub fn router(root: SharedRoot, token: String) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD])
        .allow_headers(Any)
        .expose_headers([
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::ACCEPT_RANGES,
        ]);
    Router::new()
        // `get` also answers HEAD; other methods get 405.
        .route("/{token}/{*path}", get(serve))
        .with_state(Arc::new(ServerState { root, token }))
        .layer(cors)
}

/// Bind `127.0.0.1` (never `localhost`) on a free port and serve in the background.
pub async fn spawn(root: SharedRoot) -> std::io::Result<MediaServerHandle> {
    let preferred = portpicker::pick_unused_port();
    let listener = match preferred {
        Some(port) => match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
        },
        None => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let port = listener.local_addr()?.port();
    let token = random_token();
    let app = router(root, token.clone());
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("media server stopped: {e}");
        }
    });
    Ok(MediaServerHandle { port, token })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;

    fn setup() -> (tempfile::TempDir, Router, String) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("aa").join("bb");
        std::fs::create_dir_all(&dir).unwrap();
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join("media.mkv"), &data).unwrap();
        std::fs::write(dir.join("index.m3u8"), "#EXTM3U\n").unwrap();
        std::fs::write(tmp.path().join("secret.txt"), "nope").unwrap();
        let root: SharedRoot = Arc::new(RwLock::new(Some(tmp.path().to_path_buf())));
        let token = random_token();
        (tmp, router(root, token.clone()), token)
    }

    async fn body_bytes(res: Response) -> Vec<u8> {
        axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    #[tokio::test]
    async fn wrong_token_is_404() {
        let (_tmp, app, _token) = setup();
        let res = app
            .oneshot(
                HttpRequest::get("/0123456789abcdef0123456789abcdef/aa/bb/media.mkv")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn range_request_returns_206_and_cors() {
        let (_tmp, app, token) = setup();
        let res = app
            .oneshot(
                HttpRequest::get(format!("/{token}/aa/bb/media.mkv"))
                    .header(header::RANGE, "bytes=0-99")
                    .header(header::ORIGIN, "http://tauri.localhost")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(res.headers()[header::CONTENT_TYPE], "video/x-matroska");
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes 0-99/1000");
        let body = body_bytes(res).await;
        assert_eq!(body.len(), 100);
        assert_eq!(body[99], 99);
    }

    #[tokio::test]
    async fn hls_mime_and_head() {
        let (_tmp, app, token) = setup();
        let res = app
            .oneshot(
                HttpRequest::head(format!("/{token}/aa/bb/index.m3u8"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "application/vnd.apple.mpegurl"
        );
    }

    #[tokio::test]
    async fn traversal_is_404() {
        let (_tmp, app, token) = setup();
        for p in [
            format!("/{token}/aa/../secret.txt"),
            format!("/{token}/aa/%2e%2e/secret.txt"),
            format!("/{token}/aa/bb/..%5C..%5Csecret.txt"),
            format!("/{token}/C:%5Cwindows%5Cwin.ini"),
        ] {
            let res = app
                .clone()
                .oneshot(HttpRequest::get(&p).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{p}");
        }
    }

    #[tokio::test]
    async fn post_is_rejected() {
        let (_tmp, app, token) = setup();
        let res = app
            .oneshot(
                HttpRequest::post(format!("/{token}/aa/bb/media.mkv"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn spawned_server_serves_over_tcp() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("aa").join("bb")).unwrap();
        std::fs::write(tmp.path().join("aa").join("bb").join("x.vtt"), "WEBVTT\n").unwrap();
        let root: SharedRoot = Arc::new(RwLock::new(Some(tmp.path().to_path_buf())));
        let handle = spawn(root).await.unwrap();
        let res = reqwest::get(format!("{}/aa/bb/x.vtt", handle.base_url()))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["content-type"], "text/vtt");
        assert_eq!(res.text().await.unwrap(), "WEBVTT\n");
    }
}
