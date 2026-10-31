mod backup;
mod db;
mod egress;
mod exec;
mod export;
mod files;
mod git;
mod hardware;
mod hello;
mod keys;
mod local;
pub mod local_worker;
mod mcp;
mod mcp_oauth;
mod model_files;
mod preview;
mod python_runtime;
mod quick;
mod repo;
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
        // Native "Save as" dialogs, used from Rust only (src/export.rs); no JS permission needed.
        .plugin(tauri_plugin_dialog::init())
        // Global quick capture; the app sets the shortcut from Settings (src/quick.rs).
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(db::Database::default())
        .manage(keys::Keys::default())
        .manage(transport::Transport::default())
        .manage(exec::Execs::default())
        .manage(preview::Previews::default())
        .manage(local::Local::default())
        .manage(model_files::Downloads::default())
        .manage(python_runtime::PyInstall::default())
        .manage(mcp::McpServers::default())
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
            export::commands::save_as,
            quick::commands::quick_capture_set,
            hello::commands::hello_available,
            hello::commands::hello_verify,
            files::commands::file_put,
            files::commands::file_get,
            files::commands::file_wipe,
            backup::commands::backup_list,
            backup::commands::backup_now,
            backup::commands::backup_restore,
            backup::commands::files_check,
            db::commands::db_open,
            db::commands::db_recover,
            db::commands::db_recovery_key,
            db::commands::db_execute,
            db::commands::db_select,
            repo::commands::repo_pick,
            repo::commands::repo_check,
            repo::commands::repo_list,
            repo::commands::repo_read,
            repo::commands::repo_read_bytes,
            repo::commands::repo_write_bytes,
            repo::commands::repo_remove_bytes,
            repo::commands::repo_open,
            repo::commands::repo_search,
            repo::commands::repo_write,
            repo::commands::repo_delete,
            repo::commands::repo_move,
            exec::commands::repo_exec,
            exec::commands::python_run,
            exec::commands::repo_exec_stop,
            exec::commands::sandbox_status,
            exec::commands::sandbox_windows_available,
            exec::commands::sandbox_windows_set,
            exec::commands::sandbox_windows_reset,
            git::commands::repo_git,
            local::commands::local_generate,
            local::commands::local_cancel,
            local::commands::local_unload,
            local::commands::local_status,
            hardware::commands::local_hardware,
            model_files::commands::local_install,
            model_files::commands::local_install_cancel,
            model_files::commands::local_installed,
            model_files::commands::local_remove,
            keys::commands::mcp_secret_set,
            keys::commands::mcp_secret_delete,
            keys::commands::mcp_secret_status,
            mcp::commands::mcp_check,
            mcp::commands::mcp_stop,
            mcp::commands::mcp_tools,
            mcp::commands::mcp_call,
            mcp::commands::mcp_sign_in,
            mcp::commands::mcp_sign_out,
            mcp::commands::mcp_signed_in,
            python_runtime::commands::python_install,
            python_runtime::commands::python_install_cancel,
            python_runtime::commands::python_status,
            python_runtime::commands::python_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
