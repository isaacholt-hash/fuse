mod db;
mod files;
mod keys;
mod preview;
mod transport;
mod web;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Auto-update from GitHub Releases (docs/releases.md); restart after installing.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Opens links from answers and Settings in the system browser (https/mailto only).
        .plugin(tauri_plugin_opener::init())
        .manage(db::Database::default())
        .manage(keys::Keys::default())
        .manage(transport::Transport::default())
        .manage(preview::Previews::default())
        // AR-05: HTML artifact previews, each with a no-network policy (src/preview.rs).
        .register_uri_scheme_protocol("preview", |ctx, request| {
            use tauri::Manager;
            preview::respond(&ctx.app_handle().state::<preview::Previews>(), &request)
        })
        .invoke_handler(tauri::generate_handler![
            keys::commands::key_status,
            keys::commands::key_save,
            keys::commands::key_test,
            keys::commands::key_delete,
            transport::commands::provider_fetch,
            transport::commands::provider_abort,
            web::commands::url_fetch,
            preview::commands::preview_put,
            files::commands::file_put,
            files::commands::file_get,
            db::commands::db_open,
            db::commands::db_recover,
            db::commands::db_recovery_key,
            db::commands::db_execute,
            db::commands::db_select,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
