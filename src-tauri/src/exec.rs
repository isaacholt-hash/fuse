//! Commands for the coding agent (CA-03, M6 step 7): one shell command in a project's linked
//! repository, after you allowed it in the app. The folder comes from the database, never from
//! the frontend. No input (stdin is closed, so a prompt fails fast instead of hanging), a time
//! limit, an output cap, and Stop or the time limit end the whole process tree. Provider keys
//! that happen to be in FUSE's own environment are not passed on.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{mpsc, oneshot};

/// The most output kept; the command goes on, but more isn't captured.
pub const MAX_OUTPUT: usize = 1024 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
pub const MAX_TIMEOUT: Duration = Duration::from_secs(600);

/// Never passed to a command: API keys for the providers FUSE talks to.
const SCRUBBED: &[&str] = &[
    "FUSE_OPENAI_API_KEY",
    "FUSE_ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExecMsg {
    /// Output as it arrives (stdout and stderr together, in arrival order).
    #[serde(rename_all = "camelCase")]
    Out { text: String },
    #[serde(rename_all = "camelCase")]
    Done {
        /// None when it was killed (time limit, Stop) or ended by a signal.
        exit_code: Option<i32>,
        timed_out: bool,
        stopped: bool,
        /// Output went past `MAX_OUTPUT` and the rest wasn't kept.
        truncated: bool,
        elapsed_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

fn shell(command: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(command);
        c
    }
    #[cfg(not(windows))]
    {
        let sh = if Path::new("/bin/bash").exists() {
            "/bin/bash"
        } else {
            "/bin/sh"
        };
        let mut c = tokio::process::Command::new(sh);
        c.arg("-c").arg(command);
        c
    }
}

/// Ends the process and everything it started.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // The command runs in its own process group (see `run`), whose id is its pid, so this
        // ends it and everything it started. Called directly: `kill -KILL -pid` means different
        // things to different `kill` binaries.
        if let Ok(pgid) = libc::pid_t::try_from(pid) {
            // SAFETY: killpg only sends a signal; a stale group id fails with ESRCH, harmlessly.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
}

async fn pump(mut from: impl AsyncRead + Unpin, to: mpsc::UnboundedSender<Vec<u8>>) {
    let mut buf = [0u8; 8192];
    loop {
        match from.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if to.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        }
    }
}

/// Runs `command` in `root`, sending output to `on` as it comes, then one `Done` (or `Error`).
/// `stop` ends it early.
pub async fn run(
    root: &Path,
    command: &str,
    timeout: Duration,
    mut stop: oneshot::Receiver<()>,
    mut on: impl FnMut(ExecMsg),
) {
    let started = Instant::now();
    let timeout = timeout.min(MAX_TIMEOUT);
    let mut cmd = shell(command);
    cmd.current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for k in SCRUBBED {
        cmd.env_remove(k);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        // No console window flashing up for each command.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            on(ExecMsg::Error {
                message: format!("Couldn't start the command: {e}"),
            });
            return;
        }
    };
    let pid = child.id();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    if let Some(out) = child.stdout.take() {
        tokio::spawn(pump(out, tx.clone()));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(pump(err, tx.clone()));
    }
    drop(tx);

    let mut kept = 0usize;
    let mut truncated = false;
    let mut pending: Vec<u8> = Vec::new();
    let mut timed_out = false;
    let mut stopped = false;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut output_open = true;
    let status = loop {
        tokio::select! {
            chunk = rx.recv(), if output_open => match chunk {
                Some(bytes) => {
                    if kept < MAX_OUTPUT {
                        let room = MAX_OUTPUT - kept;
                        let take = bytes.len().min(room);
                        kept += take;
                        pending.extend_from_slice(&bytes[..take]);
                        if take < bytes.len() {
                            truncated = true;
                        }
                        let text = crate::transport::take_utf8(&mut pending);
                        if !text.is_empty() {
                            on(ExecMsg::Out { text });
                        }
                    } else {
                        truncated = true;
                    }
                }
                None => output_open = false,
            },
            s = child.wait(), if !output_open => break s.ok(),
            _ = &mut deadline => {
                timed_out = true;
                if let Some(pid) = pid { kill_tree(pid); }
                break child.wait().await.ok();
            }
            _ = &mut stop => {
                stopped = true;
                if let Some(pid) = pid { kill_tree(pid); }
                break child.wait().await.ok();
            }
        }
    };
    if !pending.is_empty() {
        on(ExecMsg::Out {
            text: String::from_utf8_lossy(&pending).into_owned(),
        });
    }
    on(ExecMsg::Done {
        exit_code: if timed_out || stopped {
            None
        } else {
            status.and_then(|s| s.code())
        },
        timed_out,
        stopped,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    });
}

/// Running commands, so Stop can end one.
#[derive(Default)]
pub struct Execs {
    next_id: AtomicU32,
    running: Mutex<HashMap<u32, oneshot::Sender<()>>>,
}

pub mod commands {
    use super::*;
    use crate::db::Database;
    use tauri::State;
    use tauri::ipc::Channel;

    /// Starts `command` in the project's linked folder; returns an id for `repo_exec_stop`.
    /// Output and the result arrive on `on_event`.
    #[tauri::command]
    pub async fn repo_exec(
        db: State<'_, Database>,
        execs: State<'_, Execs>,
        folder_id: String,
        command: String,
        timeout_secs: Option<u64>,
        on_event: Channel<ExecMsg>,
    ) -> Result<u32, String> {
        if command.trim().is_empty() {
            return Err("Give a command to run.".into());
        }
        let (root, _) = crate::repo::folder_root(&db.pool()?, &folder_id).await?;
        let root = std::fs::canonicalize(&root)
            .map_err(|e| format!("The linked folder is missing: {e}"))?;
        let id = execs.next_id.fetch_add(1, Ordering::Relaxed);
        let (stop_tx, stop_rx) = oneshot::channel();
        execs
            .running
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, stop_tx);
        let timeout = timeout_secs
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_TIMEOUT);
        tauri::async_runtime::spawn(async move {
            run(&root, &command, timeout, stop_rx, |m| {
                let _ = on_event.send(m);
            })
            .await;
        });
        Ok(id)
    }

    #[tauri::command]
    pub fn repo_exec_stop(execs: State<'_, Execs>, id: u32) -> Result<(), String> {
        if let Some(stop) = execs.running.lock().map_err(|e| e.to_string())?.remove(&id) {
            let _ = stop.send(());
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    async fn go(command: &str, timeout: Duration) -> (String, ExecMsg) {
        let dir = std::env::temp_dir().join(format!(
            "fuse-exec-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker.txt"), "here").unwrap();
        let (_tx, rx) = oneshot::channel();
        let mut out = String::new();
        let mut done = None;
        run(&dir, command, timeout, rx, |m| match m {
            ExecMsg::Out { text } => out.push_str(&text),
            other => done = Some(other),
        })
        .await;
        std::mem::forget(_tx);
        (out, done.unwrap())
    }

    fn code(m: &ExecMsg) -> Option<i32> {
        match m {
            ExecMsg::Done { exit_code, .. } => *exit_code,
            _ => panic!("not done: {m:?}"),
        }
    }

    #[tokio::test]
    async fn output_exit_code_and_folder() {
        let (out, done) = go(
            "cat marker.txt; echo; echo oops >&2; exit 3",
            DEFAULT_TIMEOUT,
        )
        .await;
        assert!(out.contains("here") && out.contains("oops"), "{out}");
        assert_eq!(code(&done), Some(3));
    }

    #[tokio::test]
    async fn no_input_and_no_provider_keys() {
        // SAFETY: tests in this module don't read this variable concurrently.
        unsafe { std::env::set_var("FUSE_ANTHROPIC_API_KEY", "fake-for-test") };
        let (out, _) = go(
            "read x || echo no-input; echo key=${FUSE_ANTHROPIC_API_KEY:-unset}",
            DEFAULT_TIMEOUT,
        )
        .await;
        assert!(out.contains("no-input"), "{out}");
        assert!(out.contains("key=unset"), "{out}");
    }

    #[tokio::test]
    async fn the_time_limit_ends_the_whole_tree() {
        let t = Instant::now();
        let (_, done) = go(
            "sleep 30 & sleep 30; echo never",
            Duration::from_millis(500),
        )
        .await;
        assert!(t.elapsed() < Duration::from_secs(10));
        assert!(matches!(
            done,
            ExecMsg::Done {
                timed_out: true,
                exit_code: None,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn stop_ends_it() {
        let dir = std::env::temp_dir();
        let (tx, rx) = oneshot::channel();
        let t = Instant::now();
        let mut result = None;
        let handle = tokio::spawn(async move {
            let mut done = None;
            run(&dir, "sleep 30", DEFAULT_TIMEOUT, rx, |m| {
                if matches!(m, ExecMsg::Done { .. }) {
                    done = Some(m);
                }
            })
            .await;
            done
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        tx.send(()).unwrap();
        if let Ok(d) = handle.await {
            result = d;
        }
        assert!(t.elapsed() < Duration::from_secs(10));
        assert!(matches!(result, Some(ExecMsg::Done { stopped: true, .. })));
    }

    #[tokio::test]
    async fn output_is_capped() {
        let (out, done) = go("head -c 3000000 /dev/zero | tr '\\0' a", DEFAULT_TIMEOUT).await;
        assert_eq!(out.len(), MAX_OUTPUT);
        assert!(matches!(
            done,
            ExecMsg::Done {
                truncated: true,
                exit_code: Some(0),
                ..
            }
        ));
    }
}
