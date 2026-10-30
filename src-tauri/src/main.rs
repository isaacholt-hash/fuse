// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // LL-02: the local model runs in a worker process of its own (src/local_worker.rs).
    if std::env::args().nth(1).as_deref() == Some(fuse_lib::local_worker::WORKER_FLAG) {
        fuse_lib::local_worker::run();
        return;
    }
    fuse_lib::run()
}
