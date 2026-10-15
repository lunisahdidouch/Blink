#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod downloads;
mod media_server;

use std::sync::{Arc, RwLock};

use tauri::{Emitter, Manager};
use tauri_plugin_log::{fern::colors::ColoredLevelConfig, Target, TargetKind};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([Target::new(TargetKind::Webview)])
                .with_colors(ColoredLevelConfig::default())
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::default().build())
        // .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            // Loopback media server for downloaded items; the root is set by `downloads_init`.
            let shared_root: media_server::SharedRoot = Arc::new(RwLock::new(None));
            let server = tauri::async_runtime::block_on(media_server::spawn(shared_root.clone()))?;
            let handle = app.handle().clone();
            let emit: downloads::EmitFn = Arc::new(move |event, payload| {
                let _ = handle.emit(event, payload);
            });
            app.manage(downloads::DownloadManager::new(
                shared_root,
                server.base_url(),
                emit,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            downloads::commands::downloads_init,
            downloads::commands::downloads_list,
            downloads::commands::downloads_enqueue,
            downloads::commands::downloads_resume,
            downloads::commands::downloads_pause,
            downloads::commands::downloads_cancel,
            downloads::commands::downloads_delete,
            downloads::commands::downloads_update_user_state,
            downloads::commands::downloads_free_space,
            downloads::commands::downloads_move_root,
            downloads::commands::downloads_open_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Blink");
}
