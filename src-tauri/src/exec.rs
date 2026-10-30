//! Commands for the coding agent (CA-03, M6 step 7): one shell command in a project's linked
//! repository, after you allowed it in the app. The folder comes from the database, never from
//! the frontend. No input (stdin is closed, so a prompt fails fast instead of hanging), a time
//! limit, an output cap, and Stop or the time limit end the whole process tree. Provider keys
//! that happen to be in FUSE's own environment are not passed on.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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

/// WF-07: where a sandboxed command may write (the chat's folders, plus a private /tmp), and
/// whether it may use the network.
#[derive(Debug, Clone)]
pub struct Sandbox {
    pub writable: Vec<PathBuf>,
    pub network: bool,
}

/// What can sandbox commands on this computer.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SandboxKind {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Bubblewrap,
    /// Windows: an AppContainer and a job object (src-tauri/sandbox-win), while it's switched on.
    #[cfg_attr(not(windows), allow(dead_code))]
    AppContainer,
    None,
}

/// M8 step 9: the Windows sandbox is off until switched on in Settings, while it's being tested
/// on a real PC. The app sets this at start from the saved setting.
static WINDOWS_SANDBOX: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "linux")]
fn bwrap_path() -> Option<PathBuf> {
    ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

/// Whether bubblewrap is here and allowed to make its namespaces (Ubuntu's AppArmor can stop
/// it): it's tried once with a command that does nothing, and the answer kept. On Windows, the
/// AppContainer when it's switched on and can be made.
pub fn sandbox_kind() -> SandboxKind {
    use std::sync::OnceLock;
    #[cfg(windows)]
    {
        static AVAILABLE: OnceLock<bool> = OnceLock::new();
        if WINDOWS_SANDBOX.load(Ordering::Relaxed)
            && *AVAILABLE.get_or_init(fuse_sandbox_win::available)
        {
            return SandboxKind::AppContainer;
        }
    }
    static KIND: OnceLock<SandboxKind> = OnceLock::new();
    *KIND.get_or_init(|| {
        #[cfg(target_os = "linux")]
        {
            if let Some(bwrap) = bwrap_path() {
                let ok = std::process::Command::new(bwrap)
                    .args([
                        "--ro-bind",
                        "/",
                        "/",
                        "--unshare-net",
                        "--die-with-parent",
                        "--",
                        "/bin/true",
                    ])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success());
                if ok {
                    return SandboxKind::Bubblewrap;
                }
            }
            SandboxKind::None
        }
        #[cfg(not(target_os = "linux"))]
        {
            SandboxKind::None
        }
    })
}

/// The command to start: in bubblewrap when asked for and available, otherwise as it is.
/// Bubblewrap: the whole system read-only, a fresh /dev, /proc and /tmp, the writable folders
/// bound back read-write, no network unless allowed, and it dies with FUSE.
fn command_for(root: &Path, command: &str, sandbox: Option<&Sandbox>) -> tokio::process::Command {
    #[cfg(target_os = "linux")]
    if let Some(sb) = sandbox
        && sandbox_kind() == SandboxKind::Bubblewrap
        && let Some(bwrap) = bwrap_path()
    {
        let sh = if Path::new("/bin/bash").exists() {
            "/bin/bash"
        } else {
            "/bin/sh"
        };
        let mut c = tokio::process::Command::new(bwrap);
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
        for w in &sb.writable {
            c.arg("--bind").arg(w).arg(w);
        }
        if !sb.network {
            c.arg("--unshare-net");
        }
        c.arg("--die-with-parent").arg("--chdir").arg(root);
        c.args(["--", sh, "-c", command]);
        return c;
    }
    let _ = (root, sandbox);
    shell(command)
}

/// Runs `command` in `root`, sending output to `on` as it comes, then one `Done` (or `Error`).
/// `stop` ends it early. With `sandbox`, it runs sandboxed where this computer can (WF-07).
pub async fn run(
    root: &Path,
    command: &str,
    timeout: Duration,
    stop: oneshot::Receiver<()>,
    sandbox: Option<&Sandbox>,
    mut on: impl FnMut(ExecMsg),
) {
    let started = Instant::now();
    let timeout = timeout.min(MAX_TIMEOUT);
    // `canonicalize` gives `\\?\C:\...`, where cmd.exe can't start.
    #[cfg(windows)]
    let root = &fuse_sandbox_win::plain(root);
    #[cfg(windows)]
    if let Some(sb) = sandbox
        && sandbox_kind() == SandboxKind::AppContainer
    {
        let spawned = fuse_sandbox_win::spawn(&fuse_sandbox_win::Spawn {
            cwd: root,
            command,
            network: sb.network,
            env_remove: SCRUBBED,
        });
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                on(ExecMsg::Error {
                    message: format!("Couldn't start the command in the sandbox: {e}"),
                });
                return;
            }
        };
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        if let Some(mut out) = child.take_output() {
            std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = [0u8; 8192];
                loop {
                    match out.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
        let killer = child.killer();
        let wait = async move {
            tokio::task::spawn_blocking(move || child.wait().ok().map(|c| c as i32))
                .await
                .ok()
                .flatten()
        };
        supervise(started, timeout, stop, rx, wait, move || killer.kill(), on).await;
        return;
    }
    let mut cmd = command_for(root, command, sandbox);
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
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    if let Some(out) = child.stdout.take() {
        tokio::spawn(pump(out, tx.clone()));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(pump(err, tx.clone()));
    }
    drop(tx);
    let wait = async move { child.wait().await.ok().and_then(|s| s.code()) };
    let kill = move || {
        if let Some(pid) = pid {
            kill_tree(pid);
        }
    };
    supervise(started, timeout, stop, rx, wait, kill, on).await;
}

/// Collects a started command's output until it ends, the time limit passes or Stop is pressed,
/// then sends `Done`. `wait` gives its exit code; `kill` ends it and everything it started.
async fn supervise(
    started: Instant,
    timeout: Duration,
    mut stop: oneshot::Receiver<()>,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
    wait: impl std::future::Future<Output = Option<i32>>,
    kill: impl Fn(),
    mut on: impl FnMut(ExecMsg),
) {
    tokio::pin!(wait);
    let mut kept = 0usize;
    let mut truncated = false;
    let mut pending: Vec<u8> = Vec::new();
    let mut timed_out = false;
    let mut stopped = false;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut output_open = true;
    let code = loop {
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
            c = &mut wait, if !output_open => break c,
            _ = &mut deadline => {
                timed_out = true;
                kill();
                break (&mut wait).await;
            }
            _ = &mut stop => {
                stopped = true;
                kill();
                break (&mut wait).await;
            }
        }
    };
    if !pending.is_empty() {
        on(ExecMsg::Out {
            text: String::from_utf8_lossy(&pending).into_owned(),
        });
    }
    on(ExecMsg::Done {
        exit_code: if timed_out || stopped { None } else { code },
        timed_out,
        stopped,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    });
}

/// M8 step 9: the folders given to the Windows sandbox, one per line, so "Reset folder
/// permissions" can take its entries off them all, even folders FUSE no longer lists.
#[cfg(windows)]
const GRANTS_FILE: &str = "sandbox-grants.txt";

/// Lets the sandbox write in each folder, noting the ones it's new on.
#[cfg(windows)]
fn grant_folders(data: &Path, folders: &[PathBuf]) -> Result<(), String> {
    let record = data.join(GRANTS_FILE);
    let mut known = std::fs::read_to_string(&record).unwrap_or_default();
    for f in folders {
        let f = fuse_sandbox_win::plain(f);
        fuse_sandbox_win::grant(&f)
            .map_err(|e| format!("Couldn't let the sandbox use {}: {e}", f.display()))?;
        let line = f.to_string_lossy().into_owned();
        if !known.lines().any(|l| l == line) {
            known.push_str(&line);
            known.push('\n');
            std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
            std::fs::write(&record, &known).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Takes the sandbox's entries off every folder it was given and deletes the container.
/// Returns how many folders were put back; a folder that's gone is skipped.
#[cfg(windows)]
fn reset_folders(data: &Path) -> Result<u32, String> {
    let record = data.join(GRANTS_FILE);
    let known = std::fs::read_to_string(&record).unwrap_or_default();
    let mut done = 0;
    let mut left = String::new();
    for line in known.lines().filter(|l| !l.is_empty()) {
        let p = Path::new(line);
        if !p.exists() {
            continue;
        }
        match fuse_sandbox_win::revoke(p) {
            Ok(()) => done += 1,
            Err(_) => {
                left.push_str(line);
                left.push('\n');
            }
        }
    }
    if left.is_empty() {
        let _ = std::fs::remove_file(&record);
        let _ = fuse_sandbox_win::remove_profile();
        Ok(done)
    } else {
        std::fs::write(&record, &left).map_err(|e| e.to_string())?;
        Err(format!(
            "Put back {done} folders; these couldn't be changed: {}",
            left.lines().collect::<Vec<_>>().join(", ")
        ))
    }
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
    // Each argument is one the frontend sends or a piece of state Tauri hands in.
    #[allow(clippy::too_many_arguments)]
    #[tauri::command]
    pub async fn repo_exec(
        app: tauri::AppHandle,
        db: State<'_, Database>,
        execs: State<'_, Execs>,
        folder_id: String,
        command: String,
        timeout_secs: Option<u64>,
        sandbox: Option<SandboxIn>,
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
        // WF-07: writable are the run's folders (each from the database), never a path sent in.
        let sandbox = match sandbox {
            Some(sb) => {
                let mut writable = vec![root.clone()];
                for f in sb.folder_ids {
                    let (p, _) = crate::repo::folder_root(&db.pool()?, &f).await?;
                    let p = std::fs::canonicalize(&p)
                        .map_err(|e| format!("A folder of this chat is missing: {e}"))?;
                    if !writable.contains(&p) {
                        writable.push(p);
                    }
                }
                Some(Sandbox {
                    writable,
                    network: sb.network,
                })
            }
            None => None,
        };
        #[cfg(windows)]
        let data = {
            use tauri::Manager;
            app.path().app_data_dir().map_err(|e| e.to_string())?
        };
        #[cfg(not(windows))]
        let _ = app;
        tauri::async_runtime::spawn(async move {
            // The first command in a folder gives the sandbox its access there, which on a
            // large folder takes a while.
            #[cfg(windows)]
            if let Some(sb) = &sandbox
                && sandbox_kind() == SandboxKind::AppContainer
            {
                let folders = sb.writable.clone();
                let granted =
                    tokio::task::spawn_blocking(move || grant_folders(&data, &folders)).await;
                let err = match granted {
                    Ok(Ok(())) => None,
                    Ok(Err(e)) => Some(e),
                    Err(e) => Some(e.to_string()),
                };
                if let Some(message) = err {
                    let _ = on_event.send(ExecMsg::Error { message });
                    return;
                }
            }
            run(&root, &command, timeout, stop_rx, sandbox.as_ref(), |m| {
                let _ = on_event.send(m);
            })
            .await;
        });
        Ok(id)
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SandboxIn {
        folder_ids: Vec<String>,
        network: bool,
    }

    /// WF-07: what sandboxes commands here ("bubblewrap", "app_container", or "none").
    #[tauri::command]
    pub fn sandbox_status() -> SandboxKind {
        sandbox_kind()
    }

    /// M8 step 9: whether this is Windows with an AppContainer to run commands in, switched
    /// on or not.
    #[tauri::command]
    pub async fn sandbox_windows_available() -> bool {
        #[cfg(windows)]
        {
            tokio::task::spawn_blocking(fuse_sandbox_win::available)
                .await
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    /// M8 step 9: switches the Windows sandbox on or off (the app saves the choice).
    #[tauri::command]
    pub fn sandbox_windows_set(on: bool) {
        WINDOWS_SANDBOX.store(on, Ordering::Relaxed);
    }

    /// M8 step 9: "Reset folder permissions": every folder given to the sandbox is put back as
    /// it was, and the container deleted. Returns how many folders were put back.
    #[tauri::command]
    pub async fn sandbox_windows_reset(app: tauri::AppHandle) -> Result<u32, String> {
        #[cfg(windows)]
        {
            use tauri::Manager;
            let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || reset_folders(&data))
                .await
                .map_err(|e| e.to_string())?
        }
        #[cfg(not(windows))]
        {
            let _ = app;
            Ok(0)
        }
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

    /// Runs `command` sandboxed in a fresh folder; None where bubblewrap can't run (it's skipped).
    async fn sandboxed(command: &str, network: bool) -> Option<(PathBuf, String, ExecMsg)> {
        if sandbox_kind() != SandboxKind::Bubblewrap {
            eprintln!("bubblewrap isn't usable here; sandbox test skipped");
            return None;
        }
        let dir = std::env::temp_dir().join(format!(
            "fuse-sbx-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let sb = Sandbox {
            writable: vec![dir.clone()],
            network,
        };
        let (_tx, rx) = oneshot::channel();
        let mut out = String::new();
        let mut done = None;
        run(&dir, command, DEFAULT_TIMEOUT, rx, Some(&sb), |m| match m {
            ExecMsg::Out { text } => out.push_str(&text),
            other => done = Some(other),
        })
        .await;
        std::mem::forget(_tx);
        Some((dir, out, done.unwrap()))
    }

    #[tokio::test]
    async fn sandboxed_commands_write_only_in_their_folders() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
        let outside = format!("{home}/.fuse-sandbox-escape-test");
        let Some((dir, out, _)) = sandboxed(
            &format!("echo inside > made.txt; echo x > '{outside}' 2>&1; echo x > /etc/fuse-escape 2>&1; cat made.txt"),
            false,
        )
        .await
        else {
            return;
        };
        assert_eq!(
            std::fs::read_to_string(dir.join("made.txt")).unwrap(),
            "inside\n"
        );
        assert!(!Path::new(&outside).exists(), "wrote outside its folder");
        assert!(out.contains("Read-only file system"), "{out}");
    }

    #[tokio::test]
    async fn sandboxed_commands_get_no_network() {
        let probe = "(exec 3<>/dev/tcp/1.1.1.1/53) 2>&1 && echo connected || echo blocked";
        let Some((_, out, _)) = sandboxed(probe, false).await else {
            return;
        };
        assert!(out.contains("blocked"), "{out}");
        assert!(!out.contains("connected"), "{out}");
    }

    #[tokio::test]
    async fn a_sandboxed_command_is_still_ended_by_its_time_limit() {
        if sandbox_kind() != SandboxKind::Bubblewrap {
            return;
        }
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let sb = Sandbox {
            writable: vec![dir.clone()],
            network: false,
        };
        let (_tx, rx) = oneshot::channel();
        let mut done = None;
        let started = Instant::now();
        run(
            &dir,
            "sleep 30",
            Duration::from_millis(500),
            rx,
            Some(&sb),
            |m| {
                if !matches!(m, ExecMsg::Out { .. }) {
                    done = Some(m);
                }
            },
        )
        .await;
        std::mem::forget(_tx);
        assert!(matches!(
            done,
            Some(ExecMsg::Done {
                timed_out: true,
                ..
            })
        ));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

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
        run(&dir, command, timeout, rx, None, |m| match m {
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
            run(&dir, "sleep 30", DEFAULT_TIMEOUT, rx, None, |m| {
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
