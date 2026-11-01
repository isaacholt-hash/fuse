//! fuse-server: FUSE as a self-hosted web app on HULK (M10). See src/server.rs.

fn main() -> std::process::ExitCode {
    fuse_lib::server_main()
}
