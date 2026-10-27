mod db;
mod files;
mod keys;
mod transport;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Auto-update from GitHub Releases (docs/releases.md); restart after installing.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        // Opens links from answers and Settings in the system browser (https/mailto only).
        .plugin(tauri_plugin_opener::init())
        .manage(keys::Keys::default())
        .manage(transport::Transport::default())
        .invoke_handler(tauri::generate_handler![
            keys::commands::key_status,
            keys::commands::key_save,
            keys::commands::key_test,
            keys::commands::key_delete,
            transport::commands::provider_fetch,
            transport::commands::provider_abort,
            files::commands::file_put,
            files::commands::file_get,
        ])
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            db::backup_before_migrations(&dir, db::migrations().len())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
