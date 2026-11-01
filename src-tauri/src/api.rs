//! The commands fuse-server serves (M10 step 3), in one table: a command's name and its
//! arguments as JSON, the way the frontend sends them to Tauri (camelCase names), go to the
//! same body the desktop command runs. Desktop-only commands (native dialogs, the hotkey,
//! Windows Hello, the local model, the Windows sandbox, MCP sign-in) aren't in it.

use std::collections::HashMap;
use std::marker::PhantomData;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ctx::{Ctx, EventSink, Sink};
use crate::exec::SandboxIn;
use crate::keys::Provider;
use crate::transport::HttpRequest;
use crate::{
    backup, db, exec, files, git, keys, mcp, preview, python_runtime, repo, transport, web,
};

/// Every command `dispatch` runs. Anything else is `unknown_command`.
pub const WEB_COMMANDS: &[&str] = &[
    "key_status",
    "key_save",
    "key_test",
    "key_delete",
    "mcp_secret_set",
    "mcp_secret_delete",
    "mcp_secret_status",
    "provider_fetch",
    "provider_abort",
    "url_fetch",
    "preview_put",
    "file_put",
    "file_get",
    "file_wipe",
    "backup_list",
    "backup_now",
    "files_check",
    "db_open",
    "db_recover",
    "db_recovery_key",
    "db_execute",
    "db_select",
    "repo_check",
    "repo_list",
    "repo_read",
    "repo_read_bytes",
    "repo_write_bytes",
    "repo_remove_bytes",
    "repo_search",
    "repo_write",
    "repo_delete",
    "repo_move",
    "repo_exec",
    "python_run",
    "repo_exec_stop",
    "sandbox_status",
    "repo_git",
    "mcp_check",
    "mcp_stop",
    "mcp_tools",
    "mcp_call",
    "mcp_sign_out",
    "mcp_signed_in",
    "python_install",
    "python_install_cancel",
    "python_status",
    "python_remove",
];

/// What a command gives back: JSON, or raw bytes (`file_get`, `repo_read_bytes`).
#[derive(Debug, PartialEq)]
pub enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

/// Makes the sink for a channel the caller opened. A channel argument arrives in `args` as
/// `{"__fuse_channel": "<id>"}`; each message the command sends on it is serialized and sent to
/// `sink(id)`. The command holds that sink while it streams (in tasks that can outlive
/// `dispatch`), and drops it when it's done: the sink's own `Drop` is how the caller learns the
/// stream has ended, so it can send its close marker.
pub trait SinkFactory: Send + Sync {
    fn sink(&self, channel_id: &str) -> Sink<Value>;
}

/// A channel argument, as the caller sends it.
#[derive(Deserialize)]
struct ChannelArg {
    #[serde(rename = "__fuse_channel")]
    id: String,
}

/// A typed sink that serializes each message and passes it on.
struct Forward<T> {
    to: Sink<Value>,
    msg: PhantomData<fn(T)>,
}

impl<T: Serialize> EventSink<T> for Forward<T> {
    fn send(&self, msg: T) -> Result<(), String> {
        self.to
            .send(serde_json::to_value(msg).map_err(|e| e.to_string())?)
    }
}

fn typed<T: Serialize + 'static>(sinks: &dyn SinkFactory, channel: &ChannelArg) -> Sink<T> {
    Arc::new(Forward {
        to: sinks.sink(&channel.id),
        msg: PhantomData,
    })
}

fn unknown(name: &str) -> Value {
    Value::String(format!("unknown_command: {name}"))
}

/// A command's result as a reply; its error is the command's own message.
fn json<T: Serialize>(result: Result<T, String>) -> Result<Reply, Value> {
    let value = result.map_err(Value::String)?;
    serde_json::to_value(value)
        .map(Reply::Json)
        .map_err(|e| Value::String(e.to_string()))
}

fn bytes(result: Result<Vec<u8>, String>) -> Result<Reply, Value> {
    result.map(Reply::Bytes).map_err(Value::String)
}

/// The folders the web app may link (M10 step 5): only ones under the server user's home, so a
/// typed path can't hand FUSE `/etc` or another user's files. `folder` is already resolved
/// (symlinks followed) by `repo::repo_check`. This guides the one signed-in user rather than
/// fencing them in: the server trusts that user, who could equally run a command there.
fn under_home(
    folder: repo::RepoInfo,
    home: Option<&std::path::Path>,
) -> Result<repo::RepoInfo, String> {
    let home = home
        .and_then(|h| std::fs::canonicalize(h).ok())
        .ok_or("The server has no home folder to allow folders under.")?;
    if std::path::Path::new(&folder.root).starts_with(&home) {
        Ok(folder)
    } else {
        Err(format!(
            "{} isn't under {}: FUSE on HULK can only use folders in its user's home.",
            folder.root,
            home.display()
        ))
    }
}

/// Runs a command body that may block (files, processes, the keychain) off the async threads.
async fn blocking<T, F>(ctx: &Arc<Ctx>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Ctx) -> Result<T, String> + Send + 'static,
{
    let ctx = ctx.clone();
    tokio::task::spawn_blocking(move || f(&ctx))
        .await
        .map_err(|e| e.to_string())?
}

/// Reads a command's arguments into local variables of the same names (snake_case here,
/// camelCase in the JSON, as Tauri reads them). A missing or ill-typed one is an error that
/// names the command.
macro_rules! args {
    ($name:expr, $args:expr, $($field:ident: $ty:ty),+ $(,)?) => {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            $($field: $ty),+
        }
        let Args { $($field),+ } = serde_json::from_value::<Args>($args)
            .map_err(|e| Value::String(format!("{}: bad arguments: {e}", $name)))?;
    };
}

/// Runs the command `name` with `args` (a JSON object), and `body` for the raw-bytes ones
/// (`file_put`, `repo_write_bytes`; header names lowercase). Errors are the command's own
/// message as a JSON string.
pub async fn dispatch(
    ctx: &Arc<Ctx>,
    name: &str,
    args: Value,
    body: Option<(Vec<u8>, HashMap<String, String>)>,
    sinks: &dyn SinkFactory,
) -> Result<Reply, Value> {
    if !WEB_COMMANDS.contains(&name) {
        return Err(unknown(name));
    }
    let raw = |body: Option<(Vec<u8>, HashMap<String, String>)>| {
        body.ok_or_else(|| Value::String(format!("{name}: expected raw bytes")))
    };
    match name {
        // Keys (keys.rs)
        "key_status" => {
            args!(name, args, provider: Provider);
            json(blocking(ctx, move |c| keys::key_status(c, provider)).await)
        }
        "key_save" => {
            args!(name, args, provider: Provider, key: String);
            json(keys::key_save(ctx, provider, key).await)
        }
        "key_test" => {
            args!(name, args, provider: Provider);
            json(keys::key_test(ctx, provider).await)
        }
        "key_delete" => {
            args!(name, args, provider: Provider);
            json(blocking(ctx, move |c| keys::key_delete(c, provider)).await)
        }
        "mcp_secret_set" => {
            args!(name, args, server_id: String, name: String, value: String);
            json(
                blocking(ctx, move |c| {
                    keys::mcp_secret_set(c, server_id, name, value)
                })
                .await,
            )
        }
        "mcp_secret_delete" => {
            args!(name, args, server_id: String, name: String);
            json(blocking(ctx, move |c| keys::mcp_secret_delete(c, server_id, name)).await)
        }
        "mcp_secret_status" => {
            args!(name, args, server_id: String, names: Vec<String>);
            json(blocking(ctx, move |c| keys::mcp_secret_status(c, server_id, names)).await)
        }

        // Provider requests and the web (transport.rs, web.rs, preview.rs)
        "provider_fetch" => {
            args!(name, args, request: HttpRequest, on_event: ChannelArg);
            let sink = typed(sinks, &on_event);
            json(transport::provider_fetch(ctx, request, sink).await)
        }
        "provider_abort" => {
            args!(name, args, id: u32);
            json(blocking(ctx, move |c| transport::provider_abort(c, id)).await)
        }
        "url_fetch" => {
            args!(name, args, url: String);
            json(web::url_fetch(url).await)
        }
        "preview_put" => {
            args!(name, args, html: String, cdn: Option<bool>);
            json(blocking(ctx, move |c| preview::preview_put(c, html, cdn)).await)
        }

        // Attachments and backups (files.rs, backup.rs)
        "file_put" => {
            let (body, headers) = raw(body)?;
            json(blocking(ctx, move |c| files::file_put(c, body, &headers)).await)
        }
        "file_get" => {
            args!(name, args, sha256: String);
            bytes(blocking(ctx, move |c| files::file_get(c, sha256)).await)
        }
        "file_wipe" => json(blocking(ctx, files::file_wipe).await),
        "backup_list" => json(blocking(ctx, backup::backup_list).await),
        "backup_now" => json(backup::backup_now(ctx).await),
        "files_check" => json(backup::files_check(ctx).await),

        // The database (db.rs)
        "db_open" => json(db::db_open(ctx).await),
        "db_recover" => {
            args!(name, args, key: String);
            json(db::db_recover(ctx, key).await)
        }
        "db_recovery_key" => json(blocking(ctx, db::db_recovery_key).await),
        "db_execute" => {
            args!(name, args, sql: String, params: Vec<Value>);
            json(db::db_execute(ctx, sql, params).await)
        }
        "db_select" => {
            args!(name, args, sql: String, params: Vec<Value>);
            json(db::db_select(ctx, sql, params).await)
        }

        // Folders (repo.rs, git.rs)
        "repo_check" => {
            args!(name, args, path: String);
            json(
                blocking(ctx, move |_| {
                    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
                    under_home(repo::repo_check(path)?, home.as_deref())
                })
                .await,
            )
        }
        "repo_list" => {
            args!(name, args, folder_id: String, path: String, recursive: bool);
            json(repo::repo_list(ctx, folder_id, path, recursive).await)
        }
        "repo_read" => {
            args!(name, args, folder_id: String, path: String, offset: u64);
            json(repo::repo_read(ctx, folder_id, path, offset).await)
        }
        "repo_read_bytes" => {
            args!(name, args, folder_id: String, path: String);
            bytes(repo::repo_read_bytes(ctx, folder_id, path).await)
        }
        "repo_write_bytes" => {
            let (body, headers) = raw(body)?;
            json(repo::repo_write_bytes(ctx, body, &headers).await)
        }
        "repo_remove_bytes" => {
            args!(name, args, folder_id: String, path: String);
            json(repo::repo_remove_bytes(ctx, folder_id, path).await)
        }
        "repo_search" => {
            args!(
                name,
                args,
                folder_id: String,
                path: String,
                query: String,
                ignore_case: bool
            );
            json(repo::repo_search(ctx, folder_id, path, query, ignore_case).await)
        }
        "repo_write" => {
            args!(name, args, folder_id: String, path: String, content: String);
            json(repo::repo_write(ctx, folder_id, path, content).await)
        }
        "repo_delete" => {
            args!(name, args, folder_id: String, path: String);
            json(repo::repo_delete(ctx, folder_id, path).await)
        }
        "repo_move" => {
            args!(name, args, folder_id: String, from: String, to: String);
            json(repo::repo_move(ctx, folder_id, from, to).await)
        }
        "repo_git" => {
            args!(name, args, folder_id: String, program: String, args: Vec<String>);
            json(git::repo_git(ctx, folder_id, program, args).await)
        }

        // Commands and Python (exec.rs)
        "repo_exec" => {
            args!(
                name,
                args,
                folder_id: String,
                command: String,
                timeout_secs: Option<u64>,
                sandbox: Option<SandboxIn>,
                on_event: ChannelArg,
            );
            let sink = typed(sinks, &on_event);
            json(exec::repo_exec(ctx, folder_id, command, timeout_secs, sandbox, sink).await)
        }
        "python_run" => {
            args!(
                name,
                args,
                folder_id: String,
                script: String,
                timeout_secs: Option<u64>,
                network: bool,
                on_event: ChannelArg,
            );
            let sink = typed(sinks, &on_event);
            json(exec::python_run(ctx, folder_id, script, timeout_secs, network, sink).await)
        }
        "repo_exec_stop" => {
            args!(name, args, id: u32);
            json(blocking(ctx, move |c| exec::repo_exec_stop(c, id)).await)
        }
        "sandbox_status" => json(blocking(ctx, |_| Ok(exec::sandbox_status())).await),

        // MCP servers (mcp.rs)
        "mcp_check" => {
            args!(name, args, server_id: String);
            json(mcp::mcp_check(ctx, server_id).await)
        }
        "mcp_stop" => {
            args!(name, args, server_id: String);
            json(mcp::mcp_stop(ctx, server_id).await)
        }
        "mcp_tools" => {
            args!(name, args, server_id: String);
            json(mcp::mcp_tools(ctx, server_id).await)
        }
        "mcp_call" => {
            args!(name, args, server_id: String, name: String, arguments: Value);
            json(mcp::mcp_call(ctx, server_id, name, arguments).await)
        }
        "mcp_sign_out" => {
            args!(name, args, server_id: String);
            json(mcp::mcp_sign_out(ctx, server_id).await)
        }
        "mcp_signed_in" => {
            args!(name, args, server_id: String);
            json(blocking(ctx, move |c| mcp::mcp_signed_in(c, server_id)).await)
        }

        // The Python runtime (python_runtime.rs)
        "python_install" => {
            args!(
                name,
                args,
                url: String,
                sha256: String,
                size_bytes: u64,
                python: String,
                release: String,
                lock: String,
                packages: Vec<String>,
                on_event: ChannelArg,
            );
            let sink = typed(sinks, &on_event);
            json(
                python_runtime::python_install(
                    ctx, url, sha256, size_bytes, python, release, lock, packages, sink,
                )
                .await,
            )
        }
        "python_install_cancel" => json(blocking(ctx, python_runtime::python_install_cancel).await),
        "python_status" => json(blocking(ctx, python_runtime::python_status).await),
        "python_remove" => json(blocking(ctx, python_runtime::python_remove).await),

        _ => Err(unknown(name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{Keys, MemoryStore};
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Commands the frontend calls with no arguments: `{}` is all they take, so they run.
    const NO_ARGS: &[&str] = &[
        "file_wipe",
        "backup_list",
        "backup_now",
        "files_check",
        "db_open",
        "db_recovery_key",
        "sandbox_status",
        "python_install_cancel",
        "python_status",
        "python_remove",
    ];

    /// Every command the desktop has that the server doesn't.
    const DESKTOP_ONLY: &[&str] = &[
        "save_as",
        "quick_capture_set",
        "hello_available",
        "hello_verify",
        "backup_restore",
        "repo_pick",
        "repo_open",
        "sandbox_windows_available",
        "sandbox_windows_set",
        "sandbox_windows_reset",
        "local_generate",
        "local_cancel",
        "local_unload",
        "local_status",
        "local_hardware",
        "local_install",
        "local_install_cancel",
        "local_installed",
        "local_remove",
        "mcp_sign_in",
    ];

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fuse-api-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_ctx(name: &str) -> (Arc<Ctx>, PathBuf) {
        let dir = temp_dir(name);
        let keys = Keys::with_store(Box::new(MemoryStore::default()));
        let ctx = Ctx::new(dir.join("data"), dir.join("config"), keys);
        (Arc::new(ctx), dir)
    }

    /// Keeps what each channel was sent, and which channels were closed (their sink dropped).
    #[derive(Default, Clone)]
    struct Recorder {
        sent: Arc<Mutex<Vec<(String, Value)>>>,
        closed: Arc<Mutex<Vec<String>>>,
    }

    struct RecordingSink {
        id: String,
        to: Recorder,
    }

    impl EventSink<Value> for RecordingSink {
        fn send(&self, msg: Value) -> Result<(), String> {
            self.to.sent.lock().unwrap().push((self.id.clone(), msg));
            Ok(())
        }
    }

    impl Drop for RecordingSink {
        fn drop(&mut self) {
            self.to.closed.lock().unwrap().push(self.id.clone());
        }
    }

    impl SinkFactory for Recorder {
        fn sink(&self, channel_id: &str) -> Sink<Value> {
            Arc::new(RecordingSink {
                id: channel_id.to_string(),
                to: self.clone(),
            })
        }
    }

    async fn call(ctx: &Arc<Ctx>, name: &str, args: Value) -> Result<Reply, Value> {
        dispatch(ctx, name, args, None, &Recorder::default()).await
    }

    fn error(r: Result<Reply, Value>) -> String {
        match r {
            Err(Value::String(s)) => s,
            other => panic!("expected an error, got {other:?}"),
        }
    }

    fn ok(r: Result<Reply, Value>) -> Value {
        match r {
            Ok(Reply::Json(v)) => v,
            other => panic!("expected JSON, got {other:?}"),
        }
    }

    #[test]
    fn the_table_has_each_command_once_and_no_desktop_only_one() {
        let mut names = WEB_COMMANDS.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), WEB_COMMANDS.len());
        for d in DESKTOP_ONLY {
            assert!(!WEB_COMMANDS.contains(d), "{d}");
        }
        // 67 commands in lib.rs: those the server runs and those only the desktop has.
        assert_eq!(WEB_COMMANDS.len() + DESKTOP_ONLY.len(), 67);
    }

    #[tokio::test]
    async fn every_web_command_dispatches() {
        let (ctx, dir) = temp_ctx("all");
        for name in WEB_COMMANDS {
            let r = call(&ctx, name, json!({})).await;
            if NO_ARGS.contains(name) {
                if let Err(Value::String(e)) = &r {
                    assert!(!e.starts_with("unknown_command"), "{name}: {e}");
                }
            } else {
                let e = error(r);
                assert!(e.starts_with(&format!("{name}: ")), "{name}: {e}");
                assert!(!e.contains("unknown_command"), "{name}: {e}");
            }
        }
        // Ill-typed arguments are refused the same way.
        let e = error(call(&ctx, "provider_abort", json!({ "id": "seven" })).await);
        assert!(e.starts_with("provider_abort: bad arguments"), "{e}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn desktop_only_and_unknown_commands_are_refused() {
        let (ctx, dir) = temp_ctx("desktop");
        for name in DESKTOP_ONLY.iter().chain(&["nope", ""]) {
            let e = error(call(&ctx, name, json!({})).await);
            assert_eq!(e, format!("unknown_command: {name}"));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn keys_and_the_database_round_trip() {
        let (ctx, dir) = temp_ctx("round");
        assert_eq!(
            ok(call(&ctx, "key_status", json!({ "provider": "openai" })).await),
            json!({ "saved": false, "masked": null })
        );
        assert!(
            error(
                call(
                    &ctx,
                    "db_select",
                    json!({ "sql": "SELECT 1", "params": [] })
                )
                .await
            )
            .contains("isn't open")
        );
        assert_eq!(ok(call(&ctx, "db_open", json!({})).await), json!("ready"));
        assert_eq!(
            ok(call(
                &ctx,
                "db_execute",
                json!({ "sql": "CREATE TABLE api_test (x INTEGER)", "params": [] })
            )
            .await),
            json!({ "rowsAffected": 0 })
        );
        assert_eq!(
            ok(call(
                &ctx,
                "db_execute",
                json!({ "sql": "INSERT INTO api_test (x) VALUES (?)", "params": [5] })
            )
            .await),
            json!({ "rowsAffected": 1 })
        );
        assert_eq!(
            ok(call(
                &ctx,
                "db_select",
                json!({ "sql": "SELECT x FROM api_test", "params": [] })
            )
            .await),
            json!([{ "x": 5 }])
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn bytes_go_in_and_come_back_raw() {
        let (ctx, dir) = temp_ctx("bytes");
        let put = dispatch(
            &ctx,
            "file_put",
            json!({}),
            Some((b"hello".to_vec(), HashMap::new())),
            &Recorder::default(),
        )
        .await;
        let sha = ok(put)["sha256"].as_str().unwrap().to_string();
        assert_eq!(
            call(&ctx, "file_get", json!({ "sha256": sha })).await,
            Ok(Reply::Bytes(b"hello".to_vec()))
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_streams_to_its_channel_and_closes_it() {
        let (ctx, dir) = temp_ctx("stream");
        let folder = dir.join("folder");
        std::fs::create_dir_all(&folder).unwrap();
        ok(call(&ctx, "db_open", json!({})).await);
        ok(call(
            &ctx,
            "db_execute",
            json!({
                "sql": "INSERT INTO folders (id, workspace_id, user_id, path, created_at, updated_at)
                        SELECT 'f1', workspace_id, id, ?, 1, 1 FROM users LIMIT 1",
                "params": [folder.to_string_lossy()]
            }),
        )
        .await);
        let recorder = Recorder::default();
        let id = dispatch(
            &ctx,
            "repo_exec",
            json!({
                "folderId": "f1",
                "command": "echo hi",
                "onEvent": { "__fuse_channel": "c1" }
            }),
            None,
            &recorder,
        )
        .await;
        assert!(matches!(ok(id), Value::Number(_)));
        for _ in 0..200 {
            if !recorder.closed.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert_eq!(*recorder.closed.lock().unwrap(), vec!["c1".to_string()]);
        let sent = recorder.sent.lock().unwrap().clone();
        assert!(sent.iter().all(|(c, _)| c == "c1"));
        let text: String = sent
            .iter()
            .filter(|(_, m)| m["type"] == "out")
            .map(|(_, m)| m["text"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(text, "hi\n");
        let done = &sent.last().unwrap().1;
        assert_eq!(done["type"], "done");
        assert_eq!(done["exitCode"], 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dispatch_can_run_on_any_thread() {
        fn assert_send<T: Send>(_: &T) {}
        let (ctx, dir) = temp_ctx("send");
        let recorder = Recorder::default();
        let fut = dispatch(&ctx, "key_status", json!({}), None, &recorder);
        assert_send(&fut);
        drop(fut);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_web_app_links_only_folders_under_the_home() {
        let home = temp_dir("home");
        let inside = home.join("projects").join("x");
        std::fs::create_dir_all(&inside).unwrap();
        let outside = temp_dir("elsewhere");
        let check = |p: &std::path::Path| repo::repo_check(p.to_string_lossy().into_owned());

        let ok = under_home(check(&inside).unwrap(), Some(&home)).unwrap();
        assert_eq!(ok.name, "x");
        assert!(under_home(check(&home).unwrap(), Some(&home)).is_ok());
        let refused = under_home(check(&outside).unwrap(), Some(&home)).unwrap_err();
        assert!(refused.contains("isn't under"), "{refused}");
        // A path that climbs out is resolved first, so `..` can't get round it.
        let climb = home.join("projects").join("..").join("..");
        assert!(under_home(check(&climb).unwrap(), Some(&home)).is_err());
        assert!(under_home(check(&inside).unwrap(), None).is_err());
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(outside);
    }
}
