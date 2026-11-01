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

use crate::ctx::{Ctx, Sink};

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
    /// M9 step 6: what a Python script left in its output folder, sent just before `Done`.
    #[serde(rename_all = "camelCase")]
    Files {
        files: Vec<OutFile>,
        /// Files left out for size or number, so the model can be told.
        skipped: Vec<String>,
    },
}

/// One file a Python script wrote, by its path inside the output folder.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// M9 step 6: the most files, and bytes in all, a script's output brings back.
pub const MAX_OUT_FILES: usize = 50;
pub const MAX_OUT_BYTES: u64 = 20 * 1024 * 1024;
/// M9 step 6: the address space a script may use, in KB (4 GB): pandas and matplotlib fit well
/// within it, a runaway loop doesn't take the computer down.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const PYTHON_MEMORY_KB: u64 = 4 * 1024 * 1024;
/// The same cap on Windows, where the job limits each process's committed memory.
#[cfg_attr(not(windows), allow(dead_code))]
pub const PYTHON_MEMORY_BYTES: usize = 4 * 1024 * 1024 * 1024;

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
pub(crate) fn bwrap_path() -> Option<PathBuf> {
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

/// M9 step 6: the runtime's Python running `script` in bubblewrap. Everything is read-only
/// (the run's folders too: a script reads them, FUSE saves what it keeps), with a fresh /dev,
/// /proc and /tmp; only `out` is writable, and it's `FUSE_OUT`. No network unless allowed, a
/// memory cap, and it dies with FUSE. None where bubblewrap can't run: Python then doesn't run.
#[cfg(target_os = "linux")]
pub fn python_command(
    root: &Path,
    python: &Path,
    script: &Path,
    out: &Path,
    network: bool,
) -> Option<tokio::process::Command> {
    if sandbox_kind() != SandboxKind::Bubblewrap {
        return None;
    }
    let bwrap = bwrap_path()?;
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
    // Bound back after the private /tmp, so a folder or script that lives under /tmp is still
    // there (read-only); then the output folder, writable.
    c.arg("--ro-bind").arg(root).arg(root);
    c.arg("--ro-bind").arg(script).arg(script);
    // The runtime's folder (`python/`, above `bin/python3`), read-only.
    if let Some(runtime) = python.parent().and_then(Path::parent) {
        c.arg("--ro-bind").arg(runtime).arg(runtime);
    }
    c.arg("--bind").arg(out).arg(out);
    if !network {
        c.arg("--unshare-net");
    }
    c.arg("--die-with-parent").arg("--chdir").arg(root);
    c.arg("--setenv").arg("FUSE_OUT").arg(out);
    for (k, v) in [
        ("HOME", "/tmp"),
        ("MPLBACKEND", "Agg"),
        ("MPLCONFIGDIR", "/tmp/matplotlib"),
        ("OPENBLAS_NUM_THREADS", "2"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("PYTHONUNBUFFERED", "1"),
    ] {
        c.args(["--setenv", k, v]);
    }
    c.args(["--", "/bin/sh", "-c"])
        .arg(format!("ulimit -v {PYTHON_MEMORY_KB}; exec \"$@\""))
        .arg("sh")
        .arg(python)
        .arg("-I")
        .arg(script);
    Some(c)
}

/// The files a script wrote in `out`, by relative path with `/`, up to the caps; the rest are
/// named in `skipped`. Links aren't followed.
pub fn collect_outputs(out: &Path) -> (Vec<OutFile>, Vec<String>) {
    fn walk(dir: &Path, base: &Path, found: &mut Vec<(String, PathBuf, u64)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for e in entries {
            let Ok(t) = e.file_type() else { continue };
            let path = e.path();
            if t.is_dir() {
                walk(&path, base, found);
            } else if t.is_file() {
                let rel = path
                    .strip_prefix(base)
                    .map(|r| r.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                let size = e.metadata().map_or(0, |m| m.len());
                found.push((rel, path, size));
            }
        }
    }
    let mut found = vec![];
    walk(out, out, &mut found);
    let (mut files, mut skipped, mut total) = (vec![], vec![], 0u64);
    for (rel, path, size) in found {
        if files.len() >= MAX_OUT_FILES || total + size > MAX_OUT_BYTES {
            skipped.push(rel);
            continue;
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
                total += size;
                files.push(OutFile { path: rel, bytes });
            }
            Err(_) => skipped.push(rel),
        }
    }
    (files, skipped)
}

/// Runs `command` in `root`, sending output to `on` as it comes, then one `Done` (or `Error`).
/// `stop` ends it early. With `sandbox`, it runs sandboxed where this computer can (WF-07).
pub async fn run(
    root: &Path,
    command: &str,
    timeout: Duration,
    stop: oneshot::Receiver<()>,
    sandbox: Option<&Sandbox>,
    on: impl FnMut(ExecMsg),
) {
    #[cfg(windows)]
    let mut on = on;
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
            container: fuse_sandbox_win::Container::Commands,
            env_set: &[],
            memory_bytes: None,
            piped: false,
            env_only: None,
        });
        match spawned {
            Ok(child) => run_contained(child, started, timeout, stop, on).await,
            Err(e) => on(ExecMsg::Error {
                message: format!("Couldn't start the command in the sandbox: {e}"),
            }),
        }
        return;
    }
    run_process(
        root,
        command_for(root, command, sandbox),
        started,
        timeout,
        stop,
        on,
    )
    .await;
}

/// Supervises a command or script started in an AppContainer: its output to `on`, the time
/// limit and Stop end its job (everything it started), then one `Done`.
#[cfg(windows)]
async fn run_contained(
    mut child: fuse_sandbox_win::Child,
    started: Instant,
    timeout: Duration,
    stop: oneshot::Receiver<()>,
    on: impl FnMut(ExecMsg),
) {
    {
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
    }
}

/// Starts `cmd` in `root` and supervises it: output to `on`, the time limit and Stop end the
/// whole process tree, then one `Done` (or `Error`). No input, and no provider keys.
async fn run_process(
    root: &Path,
    mut cmd: tokio::process::Command,
    started: Instant,
    timeout: Duration,
    stop: oneshot::Receiver<()>,
    mut on: impl FnMut(ExecMsg),
) {
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

/// M9 step 6: lets Python's container read `folder` and the runtime, and write `work`; each is
/// recorded so "Reset folder permissions" takes it off again.
#[cfg(windows)]
fn grant_python(data: &Path, folder: &Path, runtime: &Path, work: &Path) -> Result<(), String> {
    use fuse_sandbox_win::{Container, READ, WRITE, grant_to, plain};
    let record = data.join(GRANTS_FILE);
    let mut known = std::fs::read_to_string(&record).unwrap_or_default();
    for (p, access) in [(folder, READ), (runtime, READ), (work, WRITE)] {
        let p = plain(p);
        grant_to(Container::Python, &p, access)
            .map_err(|e| format!("Couldn't let Python's sandbox use {}: {e}", p.display()))?;
        let line = p.to_string_lossy().into_owned();
        if !known.lines().any(|l| l == line) {
            known.push_str(&line);
            known.push('\n');
            std::fs::write(&record, &known).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// M9: lets the MCP container write a local server's own folder, recorded like the rest.
#[cfg(windows)]
pub(crate) fn grant_mcp(data: &Path, work: &Path) -> Result<(), String> {
    use fuse_sandbox_win::{Container, WRITE, grant_to, plain};
    let p = plain(work);
    grant_to(Container::Mcp, &p, WRITE)
        .map_err(|e| format!("Couldn't let the MCP sandbox use {}: {e}", p.display()))?;
    let record = data.join(GRANTS_FILE);
    let mut known = std::fs::read_to_string(&record).unwrap_or_default();
    let line = p.to_string_lossy().into_owned();
    if !known.lines().any(|l| l == line) {
        known.push_str(&line);
        known.push('\n');
        std::fs::write(&record, &known).map_err(|e| e.to_string())?;
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
        // Every container: commands', Python's (M9 step 6) and MCP servers'.
        let python = fuse_sandbox_win::revoke_from(fuse_sandbox_win::Container::Python, p);
        let mcp = fuse_sandbox_win::revoke_from(fuse_sandbox_win::Container::Mcp, p);
        match fuse_sandbox_win::revoke(p).and(python).and(mcp) {
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
        let _ = fuse_sandbox_win::remove_profile_of(fuse_sandbox_win::Container::Python);
        let _ = fuse_sandbox_win::remove_profile_of(fuse_sandbox_win::Container::Mcp);
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

// The commands' bodies (M10 step 2), without Tauri.

/// Starts `command` in the project's linked folder; returns an id for `repo_exec_stop`.
/// Output and the result arrive on `on_event`.
pub(crate) async fn repo_exec(
    ctx: &Ctx,
    folder_id: String,
    command: String,
    timeout_secs: Option<u64>,
    sandbox: Option<SandboxIn>,
    on_event: Sink<ExecMsg>,
) -> Result<u32, String> {
    if command.trim().is_empty() {
        return Err("Give a command to run.".into());
    }
    let db = &ctx.db;
    let execs = &ctx.execs;
    let (root, _) = crate::repo::folder_root(&db.pool()?, &folder_id).await?;
    let root =
        std::fs::canonicalize(&root).map_err(|e| format!("The linked folder is missing: {e}"))?;
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
    let data = ctx.data_dir.clone();
    tokio::spawn(async move {
        // The first command in a folder gives the sandbox its access there, which on a
        // large folder takes a while.
        #[cfg(windows)]
        if let Some(sb) = &sandbox
            && sandbox_kind() == SandboxKind::AppContainer
        {
            let folders = sb.writable.clone();
            let granted = tokio::task::spawn_blocking(move || grant_folders(&data, &folders)).await;
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

/// M9 step 6: runs `script` with FUSE's Python runtime in the run's first folder (from the
/// database), sandboxed. Output, then the files it wrote (`Files`), then `Done`, arrive on
/// `on_event`; returns an id for `repo_exec_stop`. Refused where it can't be sandboxed.
pub(crate) async fn python_run(
    ctx: &Ctx,
    folder_id: String,
    script: String,
    timeout_secs: Option<u64>,
    network: bool,
    on_event: Sink<ExecMsg>,
) -> Result<u32, String> {
    if script.trim().is_empty() {
        return Err("Give a script to run.".into());
    }
    let execs = &ctx.execs;
    let data = ctx.data_dir.clone();
    let runtime = data.join("python-runtime");
    let python = crate::python_runtime::python_exe(&runtime.join("python"));
    if crate::python_runtime::status(&runtime).is_none() {
        return Err(
            "Python isn't installed. Install it in Settings → Python for data work.".into(),
        );
    }
    let (root, _) = crate::repo::folder_root(&ctx.db.pool()?, &folder_id).await?;
    let root =
        std::fs::canonicalize(&root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let id = execs.next_id.fetch_add(1, Ordering::Relaxed);
    let work = runtime.join("work").join(id.to_string());
    let _ = std::fs::remove_dir_all(&work);
    let out = work.join("out");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let script_path = work.join("script.py");
    std::fs::write(&script_path, script).map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    let cmd = python_command(&root, &python, &script_path, &out, network);
    #[cfg(not(target_os = "linux"))]
    let cmd: Option<tokio::process::Command> = None;
    // M9 step 6: on Windows, Python's own AppContainer, given read access to the folder and
    // the runtime and write access to its work folder; a 4 GB memory cap per process.
    #[cfg(windows)]
    if sandbox_kind() == SandboxKind::AppContainer {
        let (stop_tx, stop_rx) = oneshot::channel();
        execs
            .running
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, stop_tx);
        let timeout = timeout_secs
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_TIMEOUT);
        let root = fuse_sandbox_win::plain(&root);
        let runtime_dir = runtime.join("python");
        tokio::spawn(async move {
            let (r, rd, w) = (root.clone(), runtime_dir.clone(), work.clone());
            let granted =
                tokio::task::spawn_blocking(move || grant_python(&data, &r, &rd, &w)).await;
            let err = match granted {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(e) => Some(e.to_string()),
            };
            if let Some(message) = err {
                let _ = on_event.send(ExecMsg::Error { message });
                let _ = std::fs::remove_dir_all(&work);
                return;
            }
            let out_s = fuse_sandbox_win::plain(&out).to_string_lossy().into_owned();
            // matplotlib's cache goes in the work folder, the one place it can write.
            let mpl_s = fuse_sandbox_win::plain(&work.join("matplotlib"))
                .to_string_lossy()
                .into_owned();
            let command = format!(
                "\"{}\" -I \"{}\"",
                fuse_sandbox_win::plain(&python).display(),
                fuse_sandbox_win::plain(&script_path).display()
            );
            let vars = [
                ("FUSE_OUT", out_s.as_str()),
                ("MPLBACKEND", "Agg"),
                ("MPLCONFIGDIR", mpl_s.as_str()),
                ("OPENBLAS_NUM_THREADS", "2"),
                ("PYTHONDONTWRITEBYTECODE", "1"),
                ("PYTHONUNBUFFERED", "1"),
            ];
            let spawned = fuse_sandbox_win::spawn(&fuse_sandbox_win::Spawn {
                cwd: &root,
                command: &command,
                network,
                env_remove: SCRUBBED,
                container: fuse_sandbox_win::Container::Python,
                env_set: &vars,
                memory_bytes: Some(PYTHON_MEMORY_BYTES),
                piped: false,
                env_only: None,
            });
            let mut done = None;
            match spawned {
                Ok(child) => {
                    run_contained(child, Instant::now(), timeout, stop_rx, |m| match m {
                        ExecMsg::Done { .. } => done = Some(m),
                        other => {
                            let _ = on_event.send(other);
                        }
                    })
                    .await;
                }
                Err(e) => {
                    let _ = on_event.send(ExecMsg::Error {
                        message: format!("Couldn't start Python in the sandbox: {e}"),
                    });
                    let _ = std::fs::remove_dir_all(&work);
                    return;
                }
            }
            let (files, skipped) = collect_outputs(&out);
            let _ = on_event.send(ExecMsg::Files { files, skipped });
            if let Some(d) = done {
                let _ = on_event.send(d);
            }
            let _ = std::fs::remove_dir_all(&work);
        });
        return Ok(id);
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    let _ = (&python, network, &data);
    let Some(cmd) = cmd else {
        let _ = std::fs::remove_dir_all(&work);
        return Err(
            "Python runs only in the sandbox, and FUSE can't sandbox it on this computer yet."
                .into(),
        );
    };
    let (stop_tx, stop_rx) = oneshot::channel();
    execs
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, stop_tx);
    let timeout = timeout_secs
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_TIMEOUT);
    tokio::spawn(async move {
        let mut done = None;
        run_process(&root, cmd, Instant::now(), timeout, stop_rx, |m| match m {
            ExecMsg::Done { .. } => done = Some(m),
            other => {
                let _ = on_event.send(other);
            }
        })
        .await;
        let (files, skipped) = collect_outputs(&out);
        let _ = on_event.send(ExecMsg::Files { files, skipped });
        if let Some(d) = done {
            let _ = on_event.send(d);
        }
        let _ = std::fs::remove_dir_all(&work);
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
pub(crate) fn sandbox_status() -> SandboxKind {
    sandbox_kind()
}

pub(crate) fn repo_exec_stop(ctx: &Ctx, id: u32) -> Result<(), String> {
    if let Some(stop) = ctx
        .execs
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
    {
        let _ = stop.send(());
    }
    Ok(())
}

pub mod commands {
    use super::*;
    use crate::ctx::channel_sink;
    use tauri::State;
    use tauri::ipc::Channel;

    #[tauri::command]
    pub async fn repo_exec(
        ctx: State<'_, Ctx>,
        folder_id: String,
        command: String,
        timeout_secs: Option<u64>,
        sandbox: Option<SandboxIn>,
        on_event: Channel<ExecMsg>,
    ) -> Result<u32, String> {
        let sink = channel_sink(on_event);
        super::repo_exec(&ctx, folder_id, command, timeout_secs, sandbox, sink).await
    }

    #[tauri::command]
    pub async fn python_run(
        ctx: State<'_, Ctx>,
        folder_id: String,
        script: String,
        timeout_secs: Option<u64>,
        network: bool,
        on_event: Channel<ExecMsg>,
    ) -> Result<u32, String> {
        let sink = channel_sink(on_event);
        super::python_run(&ctx, folder_id, script, timeout_secs, network, sink).await
    }

    #[tauri::command]
    pub fn sandbox_status() -> SandboxKind {
        super::sandbox_status()
    }

    /// M8 step 9: whether this is Windows with an AppContainer to run commands in, switched
    /// on or not. Desktop only.
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
    pub fn repo_exec_stop(ctx: State<'_, Ctx>, id: u32) -> Result<(), String> {
        super::repo_exec_stop(&ctx, id)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn fresh(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fuse-py-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn outputs_are_collected_by_path_up_to_the_caps() {
        let out = fresh("outputs");
        std::fs::create_dir_all(out.join("charts")).unwrap();
        std::fs::write(out.join("charts").join("a.png"), b"png").unwrap();
        std::fs::write(out.join("summary.csv"), b"a,b\n1,2\n").unwrap();
        let (files, skipped) = collect_outputs(&out);
        assert_eq!(
            files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["charts/a.png", "summary.csv"]
        );
        assert_eq!(files[1].bytes, b"a,b\n1,2\n");
        assert!(skipped.is_empty());

        for i in 0..MAX_OUT_FILES {
            std::fs::write(out.join(format!("n{i:03}.txt")), b"x").unwrap();
        }
        let (files, skipped) = collect_outputs(&out);
        assert_eq!(files.len(), MAX_OUT_FILES);
        assert_eq!(skipped.len(), 2);
        let _ = std::fs::remove_dir_all(&out);
    }

    /// Runs `script` with the system's python3 as FUSE runs the runtime's; None where
    /// bubblewrap or python3 isn't here (skipped).
    #[cfg(target_os = "linux")]
    async fn python(
        script: &str,
        network: bool,
    ) -> Option<(String, Option<i32>, PathBuf, PathBuf)> {
        let py = Path::new("/usr/bin/python3");
        if sandbox_kind() != SandboxKind::Bubblewrap || !py.exists() {
            eprintln!("bubblewrap or python3 isn't here; Python sandbox test skipped");
            return None;
        }
        let root = fresh(&format!("root-{}", script.len()));
        std::fs::write(root.join("data.csv"), b"x\n1\n2\n").unwrap();
        let work = fresh(&format!("work-{}", script.len()));
        let out = work.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let script_path = work.join("script.py");
        std::fs::write(&script_path, script).unwrap();
        let cmd = python_command(&root, py, &script_path, &out, network)?;
        let (_tx, rx) = oneshot::channel();
        let mut text = String::new();
        let mut code = None;
        run_process(
            &root,
            cmd,
            Instant::now(),
            DEFAULT_TIMEOUT,
            rx,
            |m| match m {
                ExecMsg::Out { text: t } => text.push_str(&t),
                ExecMsg::Done { exit_code, .. } => code = exit_code,
                _ => {}
            },
        )
        .await;
        Some((text, code, root, out))
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn python_reads_the_folder_writes_only_its_output_and_has_no_network() {
        let script = r#"
import os, socket
print("rows", sum(1 for _ in open("data.csv")) - 1)
open(os.path.join(os.environ["FUSE_OUT"], "made.txt"), "w").write("made")
try:
    open("sneaky.txt", "w").write("x")
    print("wrote the folder")
except OSError as e:
    print("folder read-only:", type(e).__name__)
try:
    socket.create_connection(("1.1.1.1", 53), timeout=3)
    print("network on")
except OSError:
    print("network off")
"#;
        let Some((text, code, root, out)) = python(script, false).await else {
            return;
        };
        assert_eq!(code, Some(0), "{text}");
        assert!(text.contains("rows 2"), "{text}");
        assert!(text.contains("folder read-only"), "{text}");
        assert!(text.contains("network off"), "{text}");
        assert!(!root.join("sneaky.txt").exists());
        assert_eq!(
            std::fs::read_to_string(out.join("made.txt")).unwrap(),
            "made"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn python_runs_out_of_memory_past_the_cap() {
        let script = "try:\n    b = bytearray(6 * 1024**3)\n    print('got 6 GB')\nexcept MemoryError:\n    print('memory capped')\n";
        let Some((text, _, _, _)) = python(script, false).await else {
            return;
        };
        assert!(text.contains("memory capped"), "{text}");
    }

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
