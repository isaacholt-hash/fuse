// The command table fuse-server serves (M10); the desktop app doesn't use it.
#[cfg_attr(not(all(feature = "server", target_os = "linux")), allow(dead_code))]
mod api;
mod backup;
#[cfg(all(feature = "server", target_os = "linux"))]
mod creds;
mod ctx;
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
#[cfg(all(feature = "server", target_os = "linux"))]
mod server;
mod transport;
mod web;

/// fuse-server's entry point (src/bin/fuse-server.rs).
#[cfg(all(feature = "server", target_os = "linux"))]
pub fn server_main() -> std::process::ExitCode {
    server::main()
}

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
        // M10 step 2: the folders and state every command runs with (src/ctx.rs).
        .setup(|app| {
            use tauri::Manager;
            let path = app.path();
            let ctx = ctx::Ctx::new(
                path.app_data_dir()?,
                path.app_config_dir()?,
                keys::Keys::default(),
            );
            app.manage(ctx);
            Ok(())
        })
        // AR-05: HTML artifact previews, each with a no-network policy (src/preview.rs).
        .register_uri_scheme_protocol("preview", |ctx, request| {
            use tauri::Manager;
            preview::respond(&ctx.app_handle().state::<ctx::Ctx>().previews, &request)
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
