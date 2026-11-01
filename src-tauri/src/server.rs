//! fuse-server (M10 step 3): the app on HULK, for a browser and the runner. It serves the built
//! UI and the same commands the desktop has (`api::WEB_COMMANDS`, nothing else) over HTTP, with
//! each command's stream messages on one WebSocket per page (src/platform/http.ts has the client
//! side). It listens only on 127.0.0.1; `tailscale serve` puts it on the tailnet. Keys and the
//! database key are systemd-creds credentials (src/creds.rs), not the desktop keychain.

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
use crate::creds::SystemdCreds;
use crate::ctx::{Ctx, EventSink, Sink};
use crate::keys::Keys;

/// Byte bodies (attachments, written files) are capped at 50 MB by the commands themselves.
const BODY_LIMIT: usize = 64 * 1024 * 1024;
const DEFAULT_PORT: u16 = 4100;

pub struct Config {
    pub port: u16,
    /// The web build (`pnpm build:web`).
    pub ui: PathBuf,
    /// Where the server keeps everything: `data/`, `config/` (the database) and `creds/`.
    pub home: PathBuf,
}

/// Messages waiting for a page's WebSocket, created by whichever comes first: the socket or
/// the first command that streams to it.
struct Outbox {
    tx: UnboundedSender<String>,
    rx: Mutex<Option<UnboundedReceiver<String>>>,
}

pub struct Server {
    ctx: Arc<Ctx>,
    clients: Mutex<HashMap<String, Arc<Outbox>>>,
}

impl Server {
    pub fn new(ctx: Ctx) -> Arc<Self> {
        Arc::new(Server {
            ctx: Arc::new(ctx),
            clients: Mutex::default(),
        })
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

async fn invoke(
    State(server): State<Arc<Server>>,
    Path(command): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
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
) -> Response {
    let client = query.get("client").cloned().unwrap_or_default();
    if client.is_empty() {
        return error(StatusCode::BAD_REQUEST, json!("events: no client id"));
    }
    ws.on_upgrade(move |socket| pump(server, client, socket))
}

/// Sends a page its channels' messages until either side goes away. One socket per page.
async fn pump(server: Arc<Server>, client: String, mut socket: WebSocket) {
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
async fn preview(State(server): State<Arc<Server>>, Path(id): Path<String>) -> Response {
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
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(server)
        .fallback_service(ServeDir::new(ui).fallback(ServeFile::new(ui.join("index.html"))))
}

/// Builds the server's `Ctx` in `home`, with its keys in systemd-creds.
pub fn context(home: &FsPath) -> Result<Ctx, String> {
    if !SystemdCreds::available() {
        return Err("This computer can't keep secrets with systemd-creds --user (it needs systemd 256 or later).".into());
    }
    let creds = SystemdCreds::new(&home.join("creds"))?;
    let data = home.join("data");
    let config = home.join("config");
    for dir in [&data, &config] {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    }
    Ok(Ctx::new(data, config, Keys::with_store(Box::new(creds))))
}

fn default_home() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("fuse-server")
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config, String> {
    let mut config = Config {
        port: DEFAULT_PORT,
        ui: PathBuf::from("dist-web"),
        home: default_home(),
    };
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--port" => config.port = value()?.parse().map_err(|_| "--port needs a number")?,
            "--ui" => config.ui = value()?.into(),
            "--home" => config.home = value()?.into(),
            _ => {
                return Err(format!(
                    "Unknown option {arg}. Options: --port, --ui, --home."
                ));
            }
        }
    }
    Ok(config)
}

pub fn main() -> ExitCode {
    let config = match parse_args(std::env::args().skip(1)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fuse-server: {e}");
            return ExitCode::from(2);
        }
    };
    // Until sign-in lands (M10 step 4) anything on this computer could use it.
    if std::env::var_os("FUSE_SERVER_NO_SIGN_IN").is_none() {
        eprintln!(
            "fuse-server: sign-in isn't built yet; set FUSE_SERVER_NO_SIGN_IN=1 to run it for testing."
        );
        return ExitCode::from(2);
    }
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
    let server = Server::new(context(&config.home)?);
    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Couldn't listen on {addr}: {e}"))?;
    println!("fuse-server {} on http://{addr}", env!("CARGO_PKG_VERSION"));
    axum::serve(listener, router(server, &config.ui))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::MemoryStore;

    async fn start(ui: &FsPath) -> (String, PathBuf) {
        let home = std::env::temp_dir().join(format!(
            "fuse-server-test-{}-{}",
            std::process::id(),
            ui.file_name().and_then(|n| n.to_str()).unwrap_or("")
        ));
        let _ = std::fs::remove_dir_all(&home);
        let ctx = Ctx::new(
            home.join("data"),
            home.join("config"),
            Keys::with_store(Box::new(MemoryStore::default())),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = router(Server::new(ctx), ui);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, home)
    }

    fn ui(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fuse-ui-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html><title>FUSE</title>").unwrap();
        dir
    }

    async fn post(base: &str, command: &str, body: &str) -> (u16, Value) {
        let r = reqwest::Client::new()
            .post(format!("{base}/api/invoke/{command}"))
            .header("content-type", "application/json")
            .header("x-fuse-client", "test")
            .body(body.to_owned())
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        (
            status,
            serde_json::from_str(&r.text().await.unwrap()).unwrap(),
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn serves_web_commands_and_refuses_the_rest() {
        let ui = ui("commands");
        let (base, home) = start(&ui).await;
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
    async fn takes_and_returns_raw_bytes() {
        let ui = ui("bytes");
        let (base, home) = start(&ui).await;
        let client = reqwest::Client::new();
        let stored: Value = serde_json::from_str(
            &client
                .post(format!("{base}/api/invoke/file_put"))
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
        let (base, home) = start(&ui).await;
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
        )
        .unwrap();
        assert_eq!((c.port, c.ui), (4200, PathBuf::from("/srv/ui")));
        assert!(parse_args(["--bogus"].map(String::from).into_iter()).is_err());
        assert!(parse_args(["--port"].map(String::from).into_iter()).is_err());
    }
}
