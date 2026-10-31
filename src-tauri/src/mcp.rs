//! MCP servers (M9 step 8, AG-02): FUSE's own small client for the Model Context Protocol, no
//! SDK. A local server is a command FUSE starts in the sandbox (bubblewrap on Linux; Windows
//! follows), writable only in its own folder (`mcp/<id>`, also its HOME), with the network only
//! when allowed and only its own variables (from the keychain) in its environment. They talk
//! JSON-RPC 2.0, one message per line on its stdin and stdout. A running server is kept for its
//! tools to be called (step 9) and ends with FUSE.

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
#[cfg(any(target_os = "linux", test))]
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc, oneshot};

/// The protocol version FUSE asks for; a server answers with the one it speaks.
pub const PROTOCOL: &str = "2025-06-18";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest message line kept from a server.
const MAX_LINE: usize = 8 * 1024 * 1024;
/// The most tool pages read from one server.
const MAX_PAGES: usize = 20;

/// One tool a server offers, with what its annotations say about it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    /// `readOnlyHint`: it only reads. Anything else counts as a write in FUSE.
    pub read_only: bool,
    /// `destructiveHint`, when the server says.
    pub destructive: Option<bool>,
}

/// A server that answered: who it says it is, and its tools.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    pub server_name: String,
    pub server_version: String,
    pub protocol: String,
    pub tools: Vec<McpTool>,
}

/// A tool from a `tools/list` entry; None when it has no name.
pub fn tool_from(v: &Value) -> Option<McpTool> {
    let name = v.get("name")?.as_str()?.to_string();
    let hints = v.get("annotations");
    let hint = |k: &str| hints.and_then(|a| a.get(k)).and_then(Value::as_bool);
    Some(McpTool {
        name,
        description: v
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        input_schema: v
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object" })),
        read_only: hint("readOnlyHint") == Some(true),
        destructive: hint("destructiveHint"),
    })
}

type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// A running server and the requests waiting on it.
pub struct Client {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
    child: Mutex<tokio::process::Child>,
    stderr_tail: Arc<std::sync::Mutex<String>>,
    /// Set once its output has ended: a request after that fails at once.
    closed: Arc<AtomicBool>,
}

impl Client {
    /// Starts `cmd` with piped stdin, stdout and stderr, and reads its messages as they come.
    pub fn spawn(mut cmd: tokio::process::Command) -> Result<Arc<Client>, String> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Couldn't start the server: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("The server has no input.")?;
        let stdout = child.stdout.take().ok_or("The server has no output.")?;
        let stderr = child.stderr.take();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });
        let pending: Pending = Arc::default();
        let stderr_tail: Arc<std::sync::Mutex<String>> = Arc::default();
        if let Some(mut err) = stderr {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                while let Ok(n) = err.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut t) = tail.lock() {
                        t.push_str(&String::from_utf8_lossy(&buf[..n]));
                        let cut = t.len().saturating_sub(2000);
                        if cut > 0 {
                            let at = (cut..t.len()).find(|&i| t.is_char_boundary(i)).unwrap_or(0);
                            t.replace_range(..at, "");
                        }
                    }
                }
            });
        }
        let closed: Arc<AtomicBool> = Arc::default();
        let (waiting, replies, tail) = (pending.clone(), tx.clone(), stderr_tail.clone());
        let ended = closed.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > MAX_LINE {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                handle(&msg, &waiting, &replies);
            }
            // It stopped: whatever was waiting gets told why, and so does anything later.
            ended.store(true, Ordering::SeqCst);
            let why = tail
                .lock()
                .map(|t| t.trim().to_string())
                .unwrap_or_default();
            let message = if why.is_empty() {
                "The server stopped.".to_string()
            } else {
                format!("The server stopped: {why}")
            };
            if let Ok(mut w) = waiting.lock() {
                for (_, tx) in w.drain() {
                    let _ = tx.send(Err(message.clone()));
                }
            }
        });
        Ok(Arc::new(Client {
            out: tx,
            pending,
            next: AtomicU64::new(1),
            child: Mutex::new(child),
            stderr_tail,
            closed,
        }))
    }

    /// One request, answered or failed within the time limit.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        // Checked after the request is registered: if the output ended before, nothing will
        // answer or fail it.
        if self.closed.load(Ordering::SeqCst) || self.out.send(msg.to_string()).is_err() {
            if let Ok(mut w) = self.pending.lock() {
                w.remove(&id);
            }
            return Err("The server stopped.".into());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("The server stopped.".into()),
            Err(_) => {
                if let Ok(mut w) = self.pending.lock() {
                    w.remove(&id);
                }
                Err(format!(
                    "The server didn't answer {method} within {} s.",
                    REQUEST_TIMEOUT.as_secs()
                ))
            }
        }
    }

    fn notify(&self, method: &str) {
        let _ = self
            .out
            .send(json!({ "jsonrpc": "2.0", "method": method }).to_string());
    }

    /// The handshake: what it is and which protocol it speaks, then `initialized`.
    pub async fn initialize(&self) -> Result<(String, String, String), String> {
        let r = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL,
                    "capabilities": {},
                    "clientInfo": { "name": "FUSE", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await?;
        self.notify("notifications/initialized");
        let info = r.get("serverInfo");
        let s = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or_default().to_string();
        Ok((
            s(info.and_then(|i| i.get("name"))),
            s(info.and_then(|i| i.get("version"))),
            s(r.get("protocolVersion")),
        ))
    }

    /// Every tool, page by page.
    pub async fn list_tools(&self) -> Result<Vec<McpTool>, String> {
        let mut tools = vec![];
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let r = self.request("tools/list", params).await?;
            if let Some(list) = r.get("tools").and_then(Value::as_array) {
                tools.extend(list.iter().filter_map(tool_from));
            }
            cursor = r
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }

    /// The last of what it wrote to stderr, for an error.
    pub fn stderr(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|t| t.trim().to_string())
            .unwrap_or_default()
    }

    pub async fn stop(&self) {
        let _ = self.child.lock().await.kill().await;
    }
}

/// A message from the server: an answer to one of FUSE's requests, or a request of its own
/// (answered: `ping` with nothing, anything else as not supported), or a notification (ignored).
fn handle(msg: &Value, waiting: &Pending, replies: &mpsc::UnboundedSender<String>) {
    let id = msg.get("id");
    if let Some(method) = msg.get("method").and_then(Value::as_str) {
        if let Some(id) = id {
            let reply = if method == "ping" {
                json!({ "jsonrpc": "2.0", "id": id, "result": {} })
            } else {
                json!({ "jsonrpc": "2.0", "id": id,
                        "error": { "code": -32601, "message": "FUSE doesn't support that." } })
            };
            let _ = replies.send(reply.to_string());
        }
        return;
    }
    let Some(n) = id.and_then(Value::as_u64) else {
        return;
    };
    let Some(tx) = waiting.lock().ok().and_then(|mut w| w.remove(&n)) else {
        return;
    };
    let answer = match (msg.get("result"), msg.get("error")) {
        (Some(r), _) => Ok(r.clone()),
        (None, Some(e)) => Err(e
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The server answered with an error.")
            .to_string()),
        (None, None) => Err("The server's answer was empty.".into()),
    };
    let _ = tx.send(answer);
}

/// A local server in bubblewrap: the whole system read-only, its own folder writable (and its
/// HOME, so `npx` and similar have somewhere to cache), a fresh /dev, /proc and /tmp, no network
/// unless allowed, and only PATH, HOME and its own variables in its environment. None where
/// bubblewrap can't run: then it doesn't run.
#[cfg(target_os = "linux")]
pub fn stdio_command(
    command: &str,
    args: &[String],
    work: &Path,
    network: bool,
    env: &[(String, String)],
) -> Option<tokio::process::Command> {
    use crate::exec::{SandboxKind, bwrap_path, sandbox_kind};
    if sandbox_kind() != SandboxKind::Bubblewrap {
        return None;
    }
    let mut c = tokio::process::Command::new(bwrap_path()?);
    c.env_clear();
    c.args([
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
    ]);
    c.arg("--bind").arg(work).arg(work);
    if !network {
        c.arg("--unshare-net");
    }
    c.arg("--die-with-parent").arg("--chdir").arg(work);
    c.args([
        "--setenv",
        "PATH",
        &std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into()),
    ]);
    c.arg("--setenv").arg("HOME").arg(work);
    for (k, v) in env {
        c.arg("--setenv").arg(k).arg(v);
    }
    c.arg("--").arg(command).args(args);
    Some(c)
}

/// Running servers, by id.
#[derive(Default)]
pub struct McpServers {
    running: Mutex<HashMap<String, Arc<Client>>>,
}

pub mod commands {
    use super::*;
    use crate::db::Database;
    use crate::keys::Keys;
    use sqlx::Row;
    use tauri::{AppHandle, Manager, State};

    /// Starts the server (again, if it was running), does the handshake and lists its tools.
    #[tauri::command]
    pub async fn mcp_check(
        app: AppHandle,
        db: State<'_, Database>,
        keys: State<'_, Keys>,
        servers: State<'_, McpServers>,
        server_id: String,
    ) -> Result<McpHealth, String> {
        if let Some(old) = servers.running.lock().await.remove(&server_id) {
            old.stop().await;
        }
        let row = sqlx::query(
            "SELECT transport, command, args, env_names, network FROM mcp_servers
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(&server_id)
        .fetch_optional(&db.pool()?)
        .await
        .map_err(|e| format!("Couldn't read the server: {e}"))?
        .ok_or("That server isn't in FUSE.")?;
        let transport: String = row.get("transport");
        if transport != "stdio" {
            return Err("Remote servers are reached in a later step; this one isn't yet.".into());
        }
        let command: String = row.get::<Option<String>, _>("command").unwrap_or_default();
        let args: Vec<String> =
            serde_json::from_str(&row.get::<String, _>("args")).map_err(|e| e.to_string())?;
        let names: Vec<String> =
            serde_json::from_str(&row.get::<String, _>("env_names")).map_err(|e| e.to_string())?;
        let network = row.get::<i64, _>("network") == 1;
        let env = crate::keys::mcp_env_for(&keys, &server_id, &names)?;
        let work = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("mcp")
            .join(&server_id);
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        let cmd = stdio_command(&command, &args, &work, network, &env);
        #[cfg(not(target_os = "linux"))]
        let cmd: Option<tokio::process::Command> = {
            let _ = (&command, &args, network, &env);
            None
        };
        let cmd = cmd.ok_or(
            "Local servers run only in the sandbox, and FUSE can't sandbox them on this computer yet.",
        )?;
        let client = Client::spawn(cmd)?;
        let started = async {
            let (server_name, server_version, protocol) = client.initialize().await?;
            let tools = client.list_tools().await?;
            Ok::<_, String>(McpHealth {
                server_name,
                server_version,
                protocol,
                tools,
            })
        }
        .await;
        match started {
            Ok(health) => {
                servers.running.lock().await.insert(server_id, client);
                Ok(health)
            }
            Err(e) => {
                let more = client.stderr();
                client.stop().await;
                Err(if more.is_empty() || e.contains(&more) {
                    e
                } else {
                    format!("{e}\n{more}")
                })
            }
        }
    }

    /// Stops a running server; nothing if it isn't.
    #[tauri::command]
    pub async fn mcp_stop(servers: State<'_, McpServers>, server_id: String) -> Result<(), String> {
        if let Some(old) = servers.running.lock().await.remove(&server_id) {
            old.stop().await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny MCP server in Python: the handshake (with a ping of its own first), two pages of
    /// tools, and an error for anything else.
    const FAKE: &str = r#"
import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if "method" not in m or "id" not in m:
        continue
    meth = m["method"]
    if meth == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": "s1", "method": "ping"}), flush=True)
        r = {"protocolVersion": m["params"]["protocolVersion"], "capabilities": {"tools": {}},
             "serverInfo": {"name": "fake", "version": "1.2"}}
    elif meth == "tools/list":
        if (m.get("params") or {}).get("cursor") is None:
            r = {"tools": [{"name": "echo", "description": "Says it back", "inputSchema":
                 {"type": "object"}, "annotations": {"readOnlyHint": True}}], "nextCursor": "p2"}
        else:
            r = {"tools": [{"name": "wipe", "annotations": {"destructiveHint": True}}, {"x": 1}]}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601,
              "message": "no such method"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
"#;

    fn fake_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fuse-mcp-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("fake.py"), FAKE).unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    fn python() -> Option<&'static str> {
        Path::new("/usr/bin/python3")
            .exists()
            .then_some("/usr/bin/python3")
    }

    #[test]
    fn tools_take_their_kind_from_annotations() {
        let t =
            tool_from(&json!({ "name": "a", "annotations": { "readOnlyHint": true } })).unwrap();
        assert!(t.read_only);
        assert_eq!(t.input_schema, json!({ "type": "object" }));
        let t = tool_from(&json!({ "name": "b", "description": "d" })).unwrap();
        assert!(!t.read_only, "no hint counts as a write");
        assert_eq!(t.destructive, None);
        assert!(tool_from(&json!({ "description": "no name" })).is_none());
    }

    #[tokio::test]
    async fn handshake_ping_and_paged_tools() {
        let Some(py) = python() else {
            eprintln!("python3 isn't here; MCP client test skipped");
            return;
        };
        let dir = fake_dir("plain");
        let mut cmd = tokio::process::Command::new(py);
        cmd.arg(dir.join("fake.py"));
        let client = Client::spawn(cmd).unwrap();
        let (name, version, protocol) = client.initialize().await.unwrap();
        assert_eq!(
            (name.as_str(), version.as_str(), protocol.as_str()),
            ("fake", "1.2", PROTOCOL)
        );
        let tools = client.list_tools().await.unwrap();
        assert_eq!(
            tools
                .iter()
                .map(|t| (t.name.as_str(), t.read_only, t.destructive))
                .collect::<Vec<_>>(),
            [("echo", true, None), ("wipe", false, Some(true))]
        );
        let err = client
            .request("resources/list", json!({}))
            .await
            .unwrap_err();
        assert_eq!(err, "no such method");
        client.stop().await;
        let err = client.request("tools/list", json!({})).await.unwrap_err();
        assert!(err.contains("stopped"), "{err}");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_local_server_runs_sandboxed_with_only_its_variables() {
        let Some(py) = python() else { return };
        if crate::exec::sandbox_kind() != crate::exec::SandboxKind::Bubblewrap {
            eprintln!("bubblewrap isn't usable here; MCP sandbox test skipped");
            return;
        }
        let dir = fake_dir("sandbox");
        // The server reports what it can see and do in its "serverInfo".
        let probe = FAKE.replace(
            r#""serverInfo": {"name": "fake", "version": "1.2"}"#,
            r#""serverInfo": {"name": ",".join(sorted(k for k in __import__("os").environ if k.startswith("FUSE") or k.endswith("_TOKEN"))), "version": str(__import__("os").access("/etc", __import__("os").W_OK)) + "/" + str(__import__("os").access(__import__("os").getcwd(), __import__("os").W_OK))}"#,
        );
        // In its own folder: the sandbox's private /tmp hides the rest of the test's folder.
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("fake.py"), probe).unwrap();
        let script = work.join("fake.py").to_string_lossy().into_owned();
        let cmd = stdio_command(
            py,
            &[script],
            &work,
            false,
            &[("API_TOKEN".into(), "t0k".into())],
        )
        .unwrap();
        let client = Client::spawn(cmd).unwrap();
        let (name, version, _) = client.initialize().await.unwrap();
        // Only its own variable; /etc read-only; its folder writable.
        assert_eq!(name, "API_TOKEN");
        assert_eq!(version, "False/True");
        client.stop().await;
    }
}
