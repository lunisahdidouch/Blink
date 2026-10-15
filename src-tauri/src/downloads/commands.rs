//! Tauri commands. Typed wrappers live in `src/utils/downloads/commands.ts`.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use super::model::{ErrorCode, ErrorInfo, InitInfo, JobSpec, Manifest, UserState};
use super::DownloadManager;

type Mgr<'a> = State<'a, Arc<DownloadManager>>;

fn default_root(app: &AppHandle) -> Result<PathBuf, ErrorInfo> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("downloads"))
        .map_err(|e| ErrorInfo::new(ErrorCode::Io, e.to_string()))
}

#[tauri::command]
pub async fn downloads_init(app: AppHandle, mgr: Mgr<'_>, root: Option<String>) -> Result<InitInfo, ErrorInfo> {
    let root = match root.filter(|r| !r.trim().is_empty()) {
        Some(r) => PathBuf::from(r),
        None => default_root(&app)?,
    };
    mgr.init(root).await
}

#[tauri::command]
pub async fn downloads_list(mgr: Mgr<'_>) -> Result<Vec<Manifest>, ErrorInfo> {
    Ok(mgr.list().await)
}

#[tauri::command]
pub async fn downloads_enqueue(mgr: Mgr<'_>, job: JobSpec) -> Result<Manifest, ErrorInfo> {
    mgr.inner().enqueue(job).await
}

/// Same as enqueue; keeps existing progress (TS supplies a fresh URL and auth header).
#[tauri::command]
pub async fn downloads_resume(mgr: Mgr<'_>, job: JobSpec) -> Result<Manifest, ErrorInfo> {
    mgr.inner().enqueue(job).await
}

#[tauri::command]
pub async fn downloads_pause(mgr: Mgr<'_>, id: String) -> Result<Manifest, ErrorInfo> {
    mgr.pause(&id).await
}

/// Cancelling discards the partial data.
#[tauri::command]
pub async fn downloads_cancel(mgr: Mgr<'_>, id: String) -> Result<(), ErrorInfo> {
    mgr.delete(&id).await
}

#[tauri::command]
pub async fn downloads_delete(mgr: Mgr<'_>, id: String) -> Result<(), ErrorInfo> {
    mgr.delete(&id).await
}

#[tauri::command]
pub async fn downloads_update_user_state(
    mgr: Mgr<'_>,
    id: String,
    user_state: UserState,
) -> Result<Manifest, ErrorInfo> {
    mgr.update_user_state(&id, user_state).await
}

#[tauri::command]
pub async fn downloads_free_space(mgr: Mgr<'_>) -> Result<u64, ErrorInfo> {
    mgr.free_space().await
}

#[tauri::command]
pub async fn downloads_move_root(
    app: AppHandle,
    mgr: Mgr<'_>,
    new_root: Option<String>,
) -> Result<InitInfo, ErrorInfo> {
    let root = match new_root.filter(|r| !r.trim().is_empty()) {
        Some(r) => PathBuf::from(r),
        None => default_root(&app)?,
    };
    mgr.inner().move_root(root).await
}

/// Open the downloads root (or one item's folder) in the OS file manager.
#[tauri::command]
pub async fn downloads_open_folder(mgr: Mgr<'_>, id: Option<String>) -> Result<(), ErrorInfo> {
    let path = mgr.item_folder(id.as_deref()).await?;
    let path = if path.exists() {
        path
    } else {
        mgr.item_folder(None).await?
    };
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| ErrorInfo::new(ErrorCode::Io, e.to_string()))
}
