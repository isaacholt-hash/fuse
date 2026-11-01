//! fuse-server (M10 step 3): the app on HULK, for a browser and the runner. It serves the built
//! UI and the same commands the desktop has (`api::WEB_COMMANDS`, nothing else) over HTTP, with
//! each command's stream messages on one WebSocket per page (src/platform/http.ts has the client
//! side). It listens only on 127.0.0.1; `tailscale serve` puts it on the tailnet. Keys and the
//! database key are systemd-creds credentials (src/creds.rs), not the desktop keychain.
//! Everything but the UI's files and sign-in itself needs a session or a device token
//! (src/auth.rs), and a browser request from another site is refused.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tower_http::services::{ServeDir, ServeFile};

use crate::api::{self, Reply, SinkFactory};
use crate::auth::{Auth, SignInError, Who};
use crate::creds::SystemdCreds;
use crate::ctx::{Ctx, EventSink, Sink};
use crate::keys::{Keys, MemoryStore, SecretStore};

/// Byte bodies (attachments, written files) are capped at 50 MB by the commands themselves.
const BODY_LIMIT: usize = 64 * 1024 * 1024;
const DEFAULT_PORT: u16 = 4100;

pub struct Config {
    pub port: u16,
    /// The web build (`pnpm build:web`).
    pub ui: PathBuf,
    /// Where the server keeps everything: `data/`, `config/` (the database) and `creds/`.
    pub home: PathBuf,
    /// The runner (`pnpm build:runner`), started with `node`; without it, nothing runs runs.
    pub runner: Option<PathBuf>,
    pub node: PathBuf,
    /// Tests only (M10 step 10): keys and the database key in memory, for the process's life,
    /// where systemd-creds can't be used (CI). Accepted only with `FUSE_SERVER_TEST=1`.
    pub test_keys_in_memory: bool,
}

/// Messages waiting for a page's WebSocket, created by whichever comes first: the socket or
/// the first command that streams to it.
struct Outbox {
    tx: UnboundedSender<String>,
    rx: Mutex<Option<UnboundedReceiver<String>>>,
}

pub struct Server {
    ctx: Arc<Ctx>,
    auth: Auth,
    clients: Mutex<HashMap<String, Arc<Outbox>>>,
}

impl Server {
    pub fn new(ctx: Ctx, auth: Auth) -> Arc<Self> {
        Arc::new(Server {
            ctx: Arc::new(ctx),
            auth,
            clients: Mutex::default(),
        })
    }

    /// Who sent this request: a session cookie (a browser) or a device token (a desktop, the
    /// runner).
    fn who(&self, headers: &HeaderMap) -> Option<Who> {
        let bearer = header_str(headers, "authorization").strip_prefix("Bearer ");
        self.auth.check(session_cookie(headers), bearer)
    }

    fn outbox(&self, client: &str) -> Arc<Outbox> {
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        clients
            .entry(client.to_owned())
            .or_insert_with(|| {
                let (tx, rx) = unbounded_channel();
                Arc::new(Outbox {
                    tx,
                    rx: Mutex::new(Some(rx)),
                })
            })
            .clone()
    }

    fn forget(&self, client: &str) {
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(client);
    }
}

/// A command's channel, sent to its page's socket. Dropping the last clone closes the channel
/// on the page.
struct SocketSink {
    tx: UnboundedSender<String>,
    channel: String,
}

impl EventSink<Value> for SocketSink {
    fn send(&self, message: Value) -> Result<(), String> {
        self.tx
            .send(json!({ "channel": self.channel, "message": message }).to_string())
            .map_err(|_| "The page went away.".to_owned())
    }
}

impl Drop for SocketSink {
    fn drop(&mut self) {
        let _ = self
            .tx
            .send(json!({ "channel": self.channel, "close": true }).to_string());
    }
}

struct ClientSinks {
    server: Arc<Server>,
    client: String,
}

impl SinkFactory for ClientSinks {
    fn sink(&self, channel_id: &str) -> Sink<Value> {
        Arc::new(SocketSink {
            tx: self.server.outbox(&self.client).tx.clone(),
            channel: channel_id.to_owned(),
        })
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

fn error(status: StatusCode, value: Value) -> Response {
    (status, axum::Json(json!({ "error": value }))).into_response()
}

const SESSION_COOKIE: &str = "fuse_session";

fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    header_str(headers, "cookie")
        .split(';')
        .filter_map(|c| c.trim().split_once('='))
        .find(|(name, _)| *name == SESSION_COOKIE)
        .map(|(_, value)| value)
}

fn with_session(token: &str, body: Value) -> Response {
    let cookie = format!(
        "{SESSION_COOKIE}={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}",
        30 * 24 * 3600
    );
    ([(header::SET_COOKIE, cookie)], axum::Json(body)).into_response()
}

fn signed_out() -> Response {
    error(StatusCode::UNAUTHORIZED, json!("signed_out"))
}

/// A page on another site can't call FUSE through your browser: a request that says where it
/// comes from must come from FUSE's own address. (The runner and a desktop send no Origin and
/// sign in with a device token, not a cookie.)
async fn same_origin(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let headers = request.headers();
    if let Some(origin) = headers.get(header::ORIGIN) {
        let host = header_str(headers, "host");
        let origin_host = origin
            .to_str()
            .ok()
            .and_then(|o| o.split_once("://"))
            .map(|(_, h)| h);
        if origin_host != Some(host) {
            return error(StatusCode::FORBIDDEN, json!("forbidden: another site"));
        }
    }
    next.run(request).await
}

fn sign_in_error(e: SignInError) -> Response {
    match e {
        SignInError::NotSetUp => error(StatusCode::CONFLICT, json!("not_set_up")),
        SignInError::Wrong => error(StatusCode::UNAUTHORIZED, json!("That isn't right.")),
        SignInError::Paused(secs) => error(
            StatusCode::TOO_MANY_REQUESTS,
            json!(format!(
                "Too many wrong tries. Try again in {} minutes.",
                secs.div_ceil(60).max(1)
            )),
        ),
        SignInError::Other(m) => error(StatusCode::INTERNAL_SERVER_ERROR, json!(m)),
    }
}

#[derive(serde::Deserialize)]
struct PassphraseBody {
    passphrase: String,
}

async fn auth_state(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    axum::Json(json!({
        "setUp": server.auth.is_set_up(),
        "signedIn": server.who(&headers).is_some(),
        "version": env!("CARGO_PKG_VERSION"),
    }))
    .into_response()
}

async fn set_up(
    State(server): State<Arc<Server>>,
    axum::Json(body): axum::Json<PassphraseBody>,
) -> Response {
    match server.auth.set_up(&body.passphrase) {
        Ok(token) => with_session(&token, json!({ "signedIn": true })),
        Err(e) => error(StatusCode::BAD_REQUEST, json!(e)),
    }
}

async fn sign_in(
    State(server): State<Arc<Server>>,
    axum::Json(body): axum::Json<PassphraseBody>,
) -> Response {
    match server.auth.sign_in(&body.passphrase) {
        Ok(token) => with_session(&token, json!({ "signedIn": true })),
        Err(e) => sign_in_error(e),
    }
}

async fn sign_out(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    if let Some(token) = session_cookie(&headers) {
        let _ = server.auth.sign_out(token);
    }
    let clear = format!("{SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
    (
        [(header::SET_COOKIE, clear)],
        axum::Json(json!({ "signedIn": false })),
    )
        .into_response()
}

/// Pairing and the device list are for a signed-in browser only, not for devices.
fn browser_only(server: &Server, headers: &HeaderMap) -> Option<Response> {
    match server.who(headers) {
        Some(Who::Session) => None,
        Some(Who::Device(_)) => Some(error(
            StatusCode::FORBIDDEN,
            json!("forbidden: devices can't do that"),
        )),
        None => Some(signed_out()),
    }
}

async fn pair_code(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    if let Some(refused) = browser_only(&server, &headers) {
        return refused;
    }
    match server.auth.pair_code() {
        Ok((code, expires)) => {
            axum::Json(json!({ "code": code, "expiresAt": expires })).into_response()
        }
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, json!(e)),
    }
}

#[derive(serde::Deserialize)]
struct PairBody {
    code: String,
    name: String,
}

async fn pair(
    State(server): State<Arc<Server>>,
    axum::Json(body): axum::Json<PairBody>,
) -> Response {
    match server.auth.pair(&body.code, &body.name) {
        Ok((device, token)) => {
            axum::Json(json!({ "device": device, "token": token })).into_response()
        }
        Err(e) => sign_in_error(e),
    }
}

async fn devices(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    if let Some(refused) = browser_only(&server, &headers) {
        return refused;
    }
    axum::Json(json!(server.auth.devices())).into_response()
}

#[derive(serde::Deserialize)]
struct RevokeBody {
    id: String,
}

async fn revoke(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<RevokeBody>,
) -> Response {
    if let Some(refused) = browser_only(&server, &headers) {
        return refused;
    }
    match server.auth.revoke(&body.id) {
        Ok(removed) => axum::Json(json!({ "removed": removed })).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, json!(e)),
    }
}

async fn invoke(
    State(server): State<Arc<Server>>,
    Path(command): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if server.who(&headers).is_none() {
        return signed_out();
    }
    let raw = header_str(&headers, "content-type") == "application/octet-stream";
    let (args, bytes) = if raw {
        // Only the command's own headers (x-file-name, x-folder-id, …) go with the bytes.
        let own = headers
            .iter()
            .filter(|(n, _)| n.as_str().starts_with("x-") && n.as_str() != "x-fuse-client")
            .filter_map(|(n, v)| Some((n.as_str().to_owned(), v.to_str().ok()?.to_owned())))
            .collect();
        (json!({}), Some((body.to_vec(), own)))
    } else if body.is_empty() {
        (json!({}), None)
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(v) => (v, None),
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    json!(format!("{command}: the arguments aren't JSON")),
                );
            }
        }
    };
    let sinks = ClientSinks {
        server: server.clone(),
        client: header_str(&headers, "x-fuse-client").to_owned(),
    };
    match api::dispatch(&server.ctx, &command, args, bytes, &sinks).await {
        Ok(Reply::Json(v)) => axum::Json(v).into_response(),
        Ok(Reply::Bytes(b)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], b).into_response()
        }
        Err(e) => error(StatusCode::BAD_REQUEST, e),
    }
}

async fn events(
    ws: WebSocketUpgrade,
    State(server): State<Arc<Server>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let client = query.get("client").cloned().unwrap_or_default();
    if client.is_empty() {
        return error(StatusCode::BAD_REQUEST, json!("events: no client id"));
    }
    let signed_in = server.who(&headers).is_some();
    ws.on_upgrade(move |socket| pump(server, client, socket, signed_in))
}

/// A socket without a session cookie must send `{"auth": "<device token>"}` first, within
/// a few seconds (a WebSocket can't carry an Authorization header).
async fn device_auth(server: &Server, socket: &mut WebSocket) -> bool {
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), socket.recv()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else {
        return false;
    };
    let token = serde_json::from_str::<Value>(text.as_str())
        .ok()
        .and_then(|v| v["auth"].as_str().map(str::to_owned));
    token.is_some_and(|t| matches!(server.auth.check(None, Some(&t)), Some(Who::Device(_))))
}

/// Sends a page its channels' messages until either side goes away. One socket per page.
async fn pump(server: Arc<Server>, client: String, mut socket: WebSocket, signed_in: bool) {
    if !signed_in && !device_auth(&server, &mut socket).await {
        let _ = socket.send(Message::Close(None)).await;
        return;
    }
    let outbox = server.outbox(&client);
    let taken = outbox.rx.lock().unwrap_or_else(|e| e.into_inner()).take();
    let Some(mut rx) = taken else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(text) => {
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    server.forget(&client);
}

/// HTML artifact previews, with the same no-network policy as on the desktop (src/preview.rs).
async fn preview(
    State(server): State<Arc<Server>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if server.who(&headers).is_none() {
        return signed_out();
    }
    let Ok(request) = axum::http::Request::builder()
        .uri(format!("/{id}"))
        .body(Vec::new())
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let (parts, body) = crate::preview::respond(&server.ctx.previews, &request).into_parts();
    Response::from_parts(parts, body.into())
}

pub fn router(server: Arc<Server>, ui: &FsPath) -> Router {
    Router::new()
        .route("/api/invoke/{command}", post(invoke))
        .route("/api/events", get(events))
        .route("/api/asset/preview/{id}", get(preview))
        .route("/api/auth/state", get(auth_state))
        .route("/api/auth/set-up", post(set_up))
        .route("/api/auth/sign-in", post(sign_in))
        .route("/api/auth/sign-out", post(sign_out))
        .route("/api/auth/pair-code", post(pair_code))
        .route("/api/auth/pair", post(pair))
        .route("/api/auth/devices", get(devices))
        .route("/api/auth/revoke", post(revoke))
        .layer(axum::middleware::from_fn(same_origin))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(server)
        .fallback_service(ServeDir::new(ui).fallback(ServeFile::new(ui.join("index.html"))))
}

/// Builds the server's `Ctx` in `home`, with its keys in systemd-creds, or in memory for the
/// test mode (`--test-keys-in-memory`).
pub fn context(home: &FsPath, keys_in_memory: bool) -> Result<Ctx, String> {
    let store: Box<dyn SecretStore> = if keys_in_memory {
        Box::new(MemoryStore::default())
    } else {
        if !SystemdCreds::available() {
            return Err("This computer can't keep secrets with systemd-creds --user (it needs systemd 256 or later).".into());
        }
        Box::new(SystemdCreds::new(&home.join("creds"))?)
    };
    let data = home.join("data");
    let config = home.join("config");
    for dir in [&data, &config] {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    }
    Ok(Ctx::new(data, config, Keys::with_store(store)))
}

fn default_home() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("fuse-server")
}

/// The environment variable that allows `--test-keys-in-memory`.
const TEST_ENV: &str = "FUSE_SERVER_TEST";

/// `test_env`: `FUSE_SERVER_TEST=1` is set, so the test-only options are allowed.
fn parse_args(mut args: impl Iterator<Item = String>, test_env: bool) -> Result<Config, String> {
    let mut config = Config {
        port: DEFAULT_PORT,
        ui: PathBuf::from("dist-web"),
        home: default_home(),
        runner: None,
        node: PathBuf::from("node"),
        test_keys_in_memory: false,
    };
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--port" => config.port = value()?.parse().map_err(|_| "--port needs a number")?,
            "--ui" => config.ui = value()?.into(),
            "--home" => config.home = value()?.into(),
            "--runner" => config.runner = Some(value()?.into()),
            "--node" => config.node = value()?.into(),
            "--test-keys-in-memory" if test_env => config.test_keys_in_memory = true,
            "--test-keys-in-memory" => {
                return Err(format!(
                    "--test-keys-in-memory is for tests only: it keeps keys and the database key in memory, so it needs {TEST_ENV}=1 set too."
                ));
            }
            _ => {
                return Err(format!(
                    "Unknown option {arg}. Options: --port, --ui, --home, --runner, --node."
                ));
            }
        }
    }
    Ok(config)
}

pub fn main() -> ExitCode {
    let test_env = std::env::var(TEST_ENV).is_ok_and(|v| v == "1");
    let config = match parse_args(std::env::args().skip(1), test_env) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fuse-server: {e}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("fuse-server: {e}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(serve(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("fuse-server: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: Config) -> Result<(), String> {
    if config.test_keys_in_memory {
        eprintln!(
            "fuse-server: WARNING: TEST MODE (--test-keys-in-memory): keys and the database key are kept in memory only and are lost when this server stops. Never use it for real data."
        );
    }
    let server = Server::new(
        context(&config.home, config.test_keys_in_memory)?,
        Auth::open(&config.home)?,
    );
    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Couldn't listen on {addr}: {e}"))?;
    println!("fuse-server {} on http://{addr}", env!("CARGO_PKG_VERSION"));
    let runner = match &config.runner {
        Some(script) => Some(Runner::start(
            config.node.clone(),
            script.clone(),
            format!("http://{addr}"),
            server.auth.runner_token()?,
        )),
        None => {
            println!("fuse-server: no --runner, so runs can't be started here");
            None
        }
    };
    axum::serve(listener, router(server, &config.ui))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            // The runner saves its runs as stopped, through the server, before the server goes.
            if let Some(r) = runner {
                r.stop().await;
            }
        })
        .await
        .map_err(|e| e.to_string())
}

/// Ctrl-C, or SIGTERM from systemd.
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    match signal(SignalKind::terminate()) {
        Ok(mut term) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

const RUNNER_RESTART: std::time::Duration = std::time::Duration::from_secs(5);

/// The runner (M10 step 6): Node running dist-runner/runner.mjs, with only what it needs in its
/// environment (no keys: its provider requests go through the server). Started again 5 s after
/// it exits, until the server stops.
struct Runner {
    stop: tokio::sync::oneshot::Sender<()>,
    done: tokio::task::JoinHandle<()>,
}

impl Runner {
    fn start(node: PathBuf, script: PathBuf, server: String, token: String) -> Self {
        let (stop, mut stopping) = tokio::sync::oneshot::channel::<()>();
        let done = tokio::spawn(async move {
            loop {
                let mut cmd = tokio::process::Command::new(&node);
                cmd.arg(&script).env_clear().kill_on_drop(true);
                for var in ["PATH", "HOME", "LANG", "TZ"] {
                    if let Some(v) = std::env::var_os(var) {
                        cmd.env(var, v);
                    }
                }
                cmd.env("FUSE_SERVER_URL", &server)
                    .env("FUSE_RUNNER_TOKEN", &token);
                match cmd.spawn() {
                    Ok(mut child) => {
                        tokio::select! {
                            status = child.wait() => {
                                let how = status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string());
                                eprintln!("fuse-server: the runner stopped ({how}); starting it again");
                            }
                            _ = &mut stopping => {
                                if let Some(pid) = child.id().and_then(|p| i32::try_from(p).ok()) {
                                    // SIGTERM: the runner stops its runs, saved as stopped.
                                    // SAFETY: kill() only sends a signal to the child we started.
                                    unsafe { libc::kill(pid, libc::SIGTERM) };
                                }
                                let ended = tokio::time::timeout(
                                    std::time::Duration::from_secs(15),
                                    child.wait(),
                                )
                                .await;
                                if ended.is_err() {
                                    let _ = child.kill().await;
                                }
                                return;
                            }
                        }
                    }
                    Err(e) => eprintln!("fuse-server: couldn't start the runner: {e}"),
                }
                tokio::select! {
                    _ = tokio::time::sleep(RUNNER_RESTART) => {}
                    _ = &mut stopping => return,
                }
            }
        });
        Runner { stop, done }
    }

    async fn stop(self) {
        let _ = self.stop.send(());
        let _ = self.done.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "correct horse battery";

    /// A server on a free port, signed up; returns its address, home and a session cookie.
    async fn start(ui: &FsPath) -> (String, PathBuf, String) {
        let home = std::env::temp_dir().join(format!(
            "fuse-server-test-{}-{}",
            std::process::id(),
            ui.file_name().and_then(|n| n.to_str()).unwrap_or("")
        ));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let ctx = Ctx::new(
            home.join("data"),
            home.join("config"),
            Keys::with_store(Box::new(MemoryStore::default())),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = router(Server::new(ctx, Auth::open(&home).unwrap()), ui);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let r = reqwest::Client::new()
            .post(format!("{base}/api/auth/set-up"))
            .header("content-type", "application/json")
            .body(json!({ "passphrase": PASS }).to_string())
            .send()
            .await
            .unwrap();
        let set = r.headers()["set-cookie"].to_str().unwrap().to_owned();
        assert!(
            set.contains("HttpOnly") && set.contains("Secure") && set.contains("SameSite=Strict")
        );
        let cookie = set.split(';').next().unwrap().to_owned();
        (base, home, cookie)
    }

    fn ui(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fuse-ui-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html><title>FUSE</title>").unwrap();
        dir
    }

    async fn send(r: reqwest::RequestBuilder) -> (u16, Value) {
        let r = r.send().await.unwrap();
        let status = r.status().as_u16();
        (
            status,
            serde_json::from_str(&r.text().await.unwrap()).unwrap(),
        )
    }

    fn call(base: &str, path: &str, body: &str) -> reqwest::RequestBuilder {
        reqwest::Client::new()
            .post(format!("{base}{path}"))
            .header("content-type", "application/json")
            .header("x-fuse-client", "test")
            .body(body.to_owned())
    }

    async fn post_as(base: &str, cookie: &str, command: &str, body: &str) -> (u16, Value) {
        send(call(base, &format!("/api/invoke/{command}"), body).header("cookie", cookie)).await
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn serves_web_commands_and_refuses_the_rest() {
        let ui = ui("commands");
        let (base, home, cookie) = start(&ui).await;
        let post = |base: &str, command: &str, body: &str| {
            let (base, command, body, cookie) = (
                base.to_owned(),
                command.to_owned(),
                body.to_owned(),
                cookie.clone(),
            );
            async move { post_as(&base, &cookie, &command, &body).await }
        };
        let (status, v) = post(&base, "key_status", r#"{"provider":"openai"}"#).await;
        assert_eq!(status, 200);
        assert_eq!(v["saved"], json!(false));

        for desktop_only in ["save_as", "local_generate", "hello_verify", "nope"] {
            let (status, v) = post(&base, desktop_only, "{}").await;
            assert_eq!(status, 400);
            assert_eq!(
                v["error"],
                json!(format!("unknown_command: {desktop_only}"))
            );
        }
        let (status, v) = post(&base, "key_status", "{not json").await;
        assert_eq!(status, 400);
        assert_eq!(v["error"], json!("key_status: the arguments aren't JSON"));

        let (status, v) = post(&base, "db_open", "").await;
        assert_eq!((status, v), (200, json!("ready")));
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ui);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn needs_a_session_or_device_and_refuses_other_sites() {
        let ui = ui("auth");
        let (base, home, cookie) = start(&ui).await;
        let status = r#"{"provider":"openai"}"#;

        // Signed out, a wrong cookie, or a wrong token: nothing runs.
        let (code, v) = send(call(&base, "/api/invoke/key_status", status)).await;
        assert_eq!((code, v["error"].clone()), (401, json!("signed_out")));
        let (code, _) = post_as(&base, "fuse_session=forged", "key_status", status).await;
        assert_eq!(code, 401);
        let (code, _) = send(
            call(&base, "/api/invoke/key_status", status).header("authorization", "Bearer forged"),
        )
        .await;
        assert_eq!(code, 401);

        // A page on another site can't use the cookie; FUSE's own address can.
        let host = base.trim_start_matches("http://").to_owned();
        let (code, v) = send(
            call(&base, "/api/invoke/key_status", status)
                .header("cookie", &cookie)
                .header("origin", "https://evil.example"),
        )
        .await;
        assert_eq!(
            (code, v["error"].clone()),
            (403, json!("forbidden: another site"))
        );
        let (code, _) = send(
            call(&base, "/api/invoke/key_status", status)
                .header("cookie", &cookie)
                .header("origin", format!("http://{host}")),
        )
        .await;
        assert_eq!(code, 200);

        // Setting up twice is refused; a wrong passphrase isn't a session.
        let (code, _) = send(call(
            &base,
            "/api/auth/set-up",
            r#"{"passphrase":"another long one"}"#,
        ))
        .await;
        assert_eq!(code, 400);
        let (code, _) = send(call(
            &base,
            "/api/auth/sign-in",
            r#"{"passphrase":"wrong wrong wrong"}"#,
        ))
        .await;
        assert_eq!(code, 401);

        // Pairing: a signed-in browser makes a code; the device trades it for a token.
        let (_, refused) = send(call(&base, "/api/auth/pair-code", "")).await;
        assert_eq!(refused["error"], json!("signed_out"));
        let (code, made) =
            send(call(&base, "/api/auth/pair-code", "").header("cookie", &cookie)).await;
        assert_eq!(code, 200);
        let pair = json!({ "code": made["code"], "name": "TCHALLA" }).to_string();
        let (code, paired) = send(call(&base, "/api/auth/pair", &pair)).await;
        assert_eq!(code, 200);
        let token = paired["token"].as_str().unwrap().to_owned();
        let bearer = format!("Bearer {token}");
        let (code, _) =
            send(call(&base, "/api/invoke/key_status", status).header("authorization", &bearer))
                .await;
        assert_eq!(code, 200);
        // A device can't pair others or list devices.
        let (code, _) =
            send(call(&base, "/api/auth/pair-code", "").header("authorization", &bearer)).await;
        assert_eq!(code, 403);

        // Revoked, its token stops working.
        let id = paired["device"]["id"].as_str().unwrap();
        let (code, _) = send(
            call(&base, "/api/auth/revoke", &json!({ "id": id }).to_string())
                .header("cookie", &cookie),
        )
        .await;
        assert_eq!(code, 200);
        let (code, _) =
            send(call(&base, "/api/invoke/key_status", status).header("authorization", &bearer))
                .await;
        assert_eq!(code, 401);

        // Signing out ends the session.
        send(call(&base, "/api/auth/sign-out", "").header("cookie", &cookie)).await;
        let (code, _) = post_as(&base, &cookie, "key_status", status).await;
        assert_eq!(code, 401);
        let state: Value = reqwest::get(format!("{base}/api/auth/state"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            (state["setUp"].clone(), state["signedIn"].clone()),
            (json!(true), json!(false))
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ui);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn takes_and_returns_raw_bytes() {
        let ui = ui("bytes");
        let (base, home, cookie) = start(&ui).await;
        let client = reqwest::Client::new();
        let stored: Value = serde_json::from_str(
            &client
                .post(format!("{base}/api/invoke/file_put"))
                .header("cookie", &cookie)
                .header("content-type", "application/octet-stream")
                .body(vec![1u8, 2, 3])
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
        )
        .unwrap();
        let sha = stored["sha256"].as_str().unwrap().to_owned();
        let got = client
            .post(format!("{base}/api/invoke/file_get"))
            .header("cookie", &cookie)
            .header("content-type", "application/json")
            .body(json!({ "sha256": sha }).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(
            got.headers()["content-type"].to_str().unwrap(),
            "application/octet-stream"
        );
        assert_eq!(got.bytes().await.unwrap().to_vec(), vec![1u8, 2, 3]);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ui);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn serves_the_ui_for_any_other_path() {
        let ui = ui("static");
        let (base, home, _) = start(&ui).await;
        for path in ["/", "/projects/abc"] {
            let body = reqwest::get(format!("{base}{path}"))
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert!(body.contains("<title>FUSE</title>"), "{path}: {body}");
        }
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ui);
    }

    #[test]
    fn options() {
        let c = parse_args(
            ["--port", "4200", "--ui", "/srv/ui"]
                .map(String::from)
                .into_iter(),
            false,
        )
        .unwrap();
        assert_eq!((c.port, c.ui), (4200, PathBuf::from("/srv/ui")));
        assert_eq!((c.runner, c.node), (None, PathBuf::from("node")));
        let c = parse_args(
            ["--runner", "r.mjs", "--node", "/usr/bin/node"]
                .map(String::from)
                .into_iter(),
            false,
        )
        .unwrap();
        assert_eq!(
            (c.runner, c.node),
            (Some(PathBuf::from("r.mjs")), PathBuf::from("/usr/bin/node"))
        );
        assert!(parse_args(["--bogus"].map(String::from).into_iter(), false).is_err());
        assert!(parse_args(["--port"].map(String::from).into_iter(), false).is_err());
    }

    #[test]
    fn keys_in_memory_only_with_the_test_variable() {
        let flag = || ["--test-keys-in-memory"].map(String::from).into_iter();
        match parse_args(flag(), false) {
            Ok(_) => panic!("--test-keys-in-memory was accepted without FUSE_SERVER_TEST=1"),
            Err(e) => assert!(e.contains("FUSE_SERVER_TEST=1"), "{e}"),
        }
        assert!(parse_args(flag(), true).is_ok_and(|c| c.test_keys_in_memory));
        assert!(parse_args(std::iter::empty(), true).is_ok_and(|c| !c.test_keys_in_memory));
    }

    #[test]
    fn test_keys_live_in_memory() {
        let home = std::env::temp_dir().join(format!("fuse-server-memkeys-{}", std::process::id()));
        let ctx = context(&home, true).unwrap();
        assert!(!home.join("creds").exists());
        drop(ctx);
        let _ = std::fs::remove_dir_all(&home);
    }
}
