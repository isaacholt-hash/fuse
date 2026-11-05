//! Approved Python packages: immutable inputs, private output and no installation permissions.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::{
    ctx::{Ctx, Sink},
    db,
    exec::{self, ExecMsg, OutFile},
};

const MAX_PACKAGE: usize = 2 * 1024 * 1024;
const MAX_FILE: usize = 256 * 1024;
const MEMORY_KB: usize = 512 * 1024;
const MAX_SECONDS: u64 = 120;
const SCRATCH_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptRequest {
    pub run_id: String,
    pub model_step_id: String,
    pub call_id: String,
    pub version_id: String,
    pub path: String,
    pub package_sha256: String,
    pub args: Vec<String>,
    pub timeout_secs: Option<u64>,
}

// Field order is the portable manifest's canonical JSON order, shared with skills/package.ts.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    path: String,
    bytes: usize,
    sha256: String,
    base64: String,
}
struct Package {
    files: Vec<(String, Vec<u8>)>,
    script_sha256: String,
}

fn digest(bytes: &[u8]) -> String {
    crate::sync::crypto::hex(&Sha256::digest(bytes))
}

// Use the existing base64url encoder; packages use padded standard base64.
fn encode64(bytes: &[u8]) -> String {
    let mut s = crate::mcp_oauth::b64url(bytes)
        .replace('-', "+")
        .replace('_', "/");
    while !s.len().is_multiple_of(4) {
        s.push('=');
    }
    s
}
fn decode64(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(4) {
        return Err("Invalid skill file encoding.".into());
    }
    let mut out = Vec::new();
    for chunk in text.as_bytes().as_chunks::<4>().0 {
        let mut n = 0u32;
        for b in chunk {
            let v = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => 0,
                _ => return Err("Invalid skill file encoding.".into()),
            };
            n = (n << 6) | u32::from(v);
        }
        out.push((n >> 16) as u8);
        if chunk[2] != b'=' {
            out.push((n >> 8) as u8);
        }
        if chunk[3] != b'=' {
            out.push(n as u8);
        }
    }
    if encode64(&out) != text {
        return Err("Noncanonical skill file encoding.".into());
    }
    Ok(out)
}

fn portable_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 240
        || !path.bytes().all(|b| (32..=126).contains(&b))
        || path.bytes().any(|b| b"\\:<>\"|?*".contains(&b))
    {
        return Err("The skill has a nonportable file path.".into());
    }
    for part in path.split('/') {
        let lower = part.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or("");
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || lower.starts_with(".env")
            || matches!(
                lower.as_str(),
                ".git"
                    | ".ssh"
                    | ".config"
                    | "node_modules"
                    | "__proto__"
                    | "constructor"
                    | "prototype"
            )
            || matches!(stem, "con" | "prn" | "aux" | "nul")
            || ((stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("The skill has an unsafe or private file path.".into());
        }
    }
    Ok(())
}

fn package(
    assets: &str,
    instructions: &str,
    expected: &str,
    entry: &str,
) -> Result<Package, String> {
    portable_path(entry)?;
    if !entry.ends_with(".py") {
        return Err("Only a selected Python .py skill script can run.".into());
    }
    if assets.len() > 3_000_000 || instructions.len() > 32768 {
        return Err("The skill exceeds its size limit.".into());
    }
    let assets: Vec<Asset> =
        serde_json::from_str(assets).map_err(|_| "The skill manifest is malformed.")?;
    if assets.is_empty()
        || assets.len() > 64
        || digest(&serde_json::to_vec(&assets).map_err(|_| "Invalid manifest.")?) != expected
    {
        return Err("The skill version failed its manifest integrity check.".into());
    }
    let mut total = 0usize;
    let mut names = BTreeSet::new();
    let mut previous = None::<String>;
    let mut files = Vec::new();
    let mut script_sha256 = None;
    let mut found_instructions = false;
    for a in assets {
        portable_path(&a.path)?;
        if previous.as_ref().is_some_and(|p| p >= &a.path)
            || !names.insert(a.path.to_ascii_lowercase())
            || a.bytes > MAX_FILE
            || a.base64.len() > MAX_FILE.div_ceil(3) * 4
        {
            return Err("The skill has duplicate, unordered or oversized files.".into());
        }
        previous = Some(a.path.clone());
        let bytes = decode64(&a.base64)?;
        if bytes.len() != a.bytes || encode64(&bytes) != a.base64 || digest(&bytes) != a.sha256 {
            return Err("A skill file failed its integrity check.".into());
        }
        total += bytes.len();
        if total > MAX_PACKAGE {
            return Err("The skill exceeds its total file limit.".into());
        }
        if a.path == "SKILL.md" {
            let text = std::str::from_utf8(&bytes).map_err(|_| "SKILL.md isn't UTF-8.")?;
            if bytes.len() > 32768
                || text.contains('\0')
                || text.trim_start_matches('\u{feff}').trim() != instructions
            {
                return Err("The skill's instructions changed.".into());
            }
            found_instructions = true;
        }
        if a.path == entry {
            if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
                return Err("The selected script isn't UTF-8 Python source.".into());
            }
            script_sha256 = Some(a.sha256);
        }
        files.push((a.path, bytes));
    }
    if !found_instructions
        || names
            .iter()
            .any(|p| names.iter().any(|n| n.starts_with(&format!("{p}/"))))
    {
        return Err("The skill has missing instructions or conflicting file paths.".into());
    }
    Ok(Package {
        files,
        script_sha256: script_sha256.ok_or("The selected script isn't in this skill version.")?,
    })
}

fn validate_request(r: &ScriptRequest) -> Result<(), String> {
    if [&r.run_id, &r.model_step_id, &r.call_id, &r.version_id]
        .iter()
        .any(|s| s.is_empty() || s.len() > 160)
        || r.package_sha256.len() != 64
        || !r.package_sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || r.args.len() > 32
        || r.args.iter().map(String::len).sum::<usize>() > 16384
        || r.args.iter().any(|s| s.contains('\0'))
        || r.timeout_secs.is_some_and(|n| n == 0 || n > MAX_SECONDS)
    {
        return Err("The skill script request exceeds its argument or execution bounds.".into());
    }
    portable_path(&r.path)
}

const ELIGIBLE: &str = "SELECT r.task,v.assets,v.instructions,v.sha256,s.name FROM runs r JOIN run_steps step ON step.run_id=r.id AND step.id=? AND step.kind='model' AND step.workspace_id=r.workspace_id AND step.user_id=r.user_id JOIN skill_versions v ON v.id=? AND v.workspace_id=r.workspace_id AND v.user_id=r.user_id JOIN skills s ON s.id=v.skill_id AND s.workspace_id=v.workspace_id AND s.user_id=v.user_id WHERE r.id=? AND r.workspace_id=? AND r.user_id=? AND r.status='running' AND r.kind IN('code','work') AND r.mode!='plan' AND r.review_profile=0 AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id)) AND (s.project_id IS NULL OR s.project_id IS r.project_id) AND (r.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.deleted_at IS NULL)) AND (r.thread_id IS NULL OR EXISTS(SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.deleted_at IS NULL AND t.project_id IS r.project_id)) AND NOT EXISTS(SELECT 1 FROM project_tools_off o WHERE o.workspace_id=r.workspace_id AND o.project_id=r.project_id AND o.tool='run_skill_script')";

async fn prepare(ctx: &Ctx, r: &ScriptRequest) -> Result<(Package, String, String), String> {
    validate_request(r)?;
    let rows = db::select(
        &ctx.db.pool()?,
        ELIGIBLE,
        &[
            json!(r.model_step_id),
            json!(r.version_id),
            json!(r.run_id),
            json!(crate::sync::WORKSPACE),
            json!(crate::sync::USER),
        ],
    )
    .await?;
    let row = rows
        .first()
        .ok_or("This execution owner no longer has permission to run that skill.")?;
    let task = row["task"].as_str().ok_or("Invalid skill task.")?;
    let command = format!(
        "/skill {}@{}",
        row["name"].as_str().ok_or("Invalid skill name.")?,
        r.version_id
    );
    let mut invoked = false;
    for line in task.trim_start().lines().take(3) {
        if !line.starts_with("/skill ") {
            break;
        }
        if line.trim() == command {
            invoked = true;
        }
    }
    if !invoked || row["sha256"] != r.package_sha256 {
        return Err("This exact skill version wasn't invoked or changed after approval.".into());
    }
    let pkg = package(
        row["assets"].as_str().ok_or("Missing skill files.")?,
        row["instructions"]
            .as_str()
            .ok_or("Missing instructions.")?,
        &r.package_sha256,
        &r.path,
    )?;
    let id = digest(
        &serde_json::to_vec(&(&r.run_id, &r.model_step_id, &r.call_id))
            .map_err(|_| "Invalid dispatch identity.")?,
    );
    Ok((pkg, id, task.to_owned()))
}

struct Scratch {
    path: PathBuf,
    #[cfg(windows)]
    container: fuse_sandbox_win::Container,
    #[cfg(windows)]
    runtime: PathBuf,
}
impl Drop for Scratch {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            for path in [&self.path, &self.runtime] {
                let _ = fuse_sandbox_win::revoke_from(self.container, path);
            }
            let _ = fuse_sandbox_win::remove_profile_of(self.container);
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn create_scratch(
    data: &Path,
    id: &str,
    pkg: &Package,
    entry: &str,
    args: &[String],
    runtime: &Path,
) -> Result<Scratch, String> {
    let base = data.join("skill-script-work");
    std::fs::create_dir_all(&base).map_err(|_| "Couldn't prepare private script storage.")?;
    let path = base.join(id);
    std::fs::create_dir(&path).map_err(
        |_| "A previous script's scratch already exists. Inspect its interrupted run first.",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Couldn't protect script storage.")?;
    }
    #[cfg(windows)]
    let container = {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "The OS couldn't create an execution identity.")?;
        fuse_sandbox_win::Container::Skill(u128::from_be_bytes(bytes))
    };
    let scratch = Scratch {
        path,
        #[cfg(windows)]
        container,
        #[cfg(windows)]
        runtime: runtime.to_owned(),
    };
    #[cfg(not(windows))]
    let _ = runtime;
    #[cfg(windows)]
    if let fuse_sandbox_win::Container::Skill(id) = scratch.container {
        std::fs::write(scratch.path.join("identity"), format!("{id:032x}"))
            .map_err(|_| "Couldn't record isolated execution cleanup.")?;
    }
    let package = scratch.path.join("package");
    std::fs::create_dir(&package).map_err(|_| "Couldn't prepare package storage.")?;
    std::fs::create_dir(scratch.path.join("out"))
        .map_err(|_| "Couldn't prepare output storage.")?;
    for (path, bytes) in &pkg.files {
        let to = package.join(path);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "Couldn't prepare package files.")?;
        }
        std::fs::write(to, bytes).map_err(|_| "Couldn't install the checked package copy.")?;
    }
    #[cfg(windows)]
    let package_path = fuse_sandbox_win::plain(&package)
        .to_string_lossy()
        .into_owned();
    #[cfg(not(windows))]
    let package_path = "/package".to_owned();
    let config = encode64(
        &serde_json::to_vec(&json!({"package":package_path,"entry":entry,"args":args}))
            .map_err(|_| "Invalid package configuration.")?,
    );
    #[cfg(target_os = "linux")]
    let isolation = linux_filter()?;
    #[cfg(not(target_os = "linux"))]
    let isolation = String::new();
    let bootstrap = format!(
        "import base64,json,os,runpy,sys\n{isolation}\ncfg=json.loads(base64.b64decode('{config}'))\nsys.path.insert(0,cfg['package'])\nsys.argv=[os.path.join(cfg['package'],cfg['entry']),*cfg['args']]\nsys.path.insert(0,os.path.dirname(sys.argv[0]))\nrunpy.run_path(sys.argv[0],run_name='__main__')\n"
    );
    std::fs::write(scratch.path.join("bootstrap.py"), bootstrap)
        .map_err(|_| "Couldn't prepare the script runner.")?;
    Ok(scratch)
}

/// Only app-owned, expired invocation folders are removed. Active invocations last at most 120s.
pub(crate) fn cleanup(data: &Path) {
    let Ok(entries) = std::fs::read_dir(data.join("skill-script-work")) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if name.len() != 64
            || !name.bytes().all(|b| b.is_ascii_hexdigit())
            || !meta.is_dir()
            || meta.file_type().is_symlink()
            || !meta
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > Duration::from_secs(180))
        {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                continue;
            }
            let id = std::fs::read_to_string(path.join("identity"))
                .ok()
                .and_then(|s| u128::from_str_radix(s.trim(), 16).ok());
            if let Some(id) = id {
                let container = fuse_sandbox_win::Container::Skill(id);
                for p in [&path, &data.join("python-runtime/python")] {
                    let _ = fuse_sandbox_win::revoke_from(container, p);
                }
                let _ = fuse_sandbox_win::remove_profile_of(container);
            }
        }
        let _ = std::fs::remove_dir_all(path);
    }
}

#[cfg(target_os = "linux")]
fn linux_filter() -> Result<String, String> {
    // The filter is installed inside Python, after bubblewrap has created its namespaces.
    // No process creation: memory bounds apply to the entire (single-process) invocation.
    #[cfg(target_arch = "x86_64")]
    let arch = 0xc000003eu32;
    #[cfg(target_arch = "aarch64")]
    let arch = 0xc00000b7u32;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return Err("Skill scripts require a supported Linux syscall architecture.".into());
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    {
        let deny = vec![
            libc::SYS_clone,
            libc::SYS_clone3,
            libc::SYS_execve,
            libc::SYS_execveat,
            libc::SYS_ptrace,
            libc::SYS_unshare,
            libc::SYS_setns,
            libc::SYS_io_uring_setup,
            libc::SYS_bpf,
        ];
        #[cfg(target_arch = "x86_64")]
        let deny = {
            let mut d = deny;
            d.extend([libc::SYS_fork, libc::SYS_vfork]);
            d
        };
        let deny = serde_json::to_string(&deny).map_err(|_| "Invalid isolation rules.")?;
        Ok(format!(
            r#"import ctypes
class _Filter(ctypes.Structure):
    _fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
class _Program(ctypes.Structure):
    _fields_=[('len',ctypes.c_ushort),('filter',ctypes.POINTER(_Filter))]
_rules=[_Filter(0x20,0,0,4),_Filter(0x15,1,0,{arch}),_Filter(6,0,0,0x80000000),_Filter(0x20,0,0,0),_Filter(0x35,0,1,0x40000000),_Filter(6,0,0,0x00050001)]
for _number in {deny}:
    _rules.extend([_Filter(0x15,0,1,_number),_Filter(6,0,0,0x00050001)])
_rules.append(_Filter(6,0,0,0x7fff0000))
_array=(_Filter*len(_rules))(*_rules)
_program=_Program(len(_rules),_array)
_libc=ctypes.CDLL(None,use_errno=True)
if _libc.prctl(38,1,0,0,0)!=0 or _libc.prctl(22,2,ctypes.byref(_program),0,0)!=0:
    raise RuntimeError('Could not enforce skill process isolation')
"#
        ))
    }
}

#[cfg(target_os = "linux")]
fn command(python_root: &Path, work: &Path) -> Result<tokio::process::Command, String> {
    let bwrap = exec::bwrap_path().ok_or("Bubblewrap is required for skill scripts.")?;
    let mut c = tokio::process::Command::new(bwrap);
    c.env_clear().env("PATH", "/usr/bin:/bin");
    c.args([
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr",
        "/usr",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--size",
        "67108864",
        "--tmpfs",
        "/tmp",
    ]);
    for path in ["/bin", "/lib", "/lib64"] {
        if Path::new(path).exists() {
            c.args(["--ro-bind", path, path]);
        }
    }
    for path in ["/etc/ld.so.cache", "/etc/fonts"] {
        if Path::new(path).exists() {
            c.args(["--ro-bind", path, path]);
        }
    }
    c.arg("--ro-bind").arg(python_root).arg("/runtime");
    c.arg("--ro-bind").arg(work.join("package")).arg("/package");
    c.arg("--ro-bind")
        .arg(work.join("bootstrap.py"))
        .arg("/bootstrap.py");
    c.arg("--bind").arg(work.join("out")).arg("/out");
    for (key, value) in [
        ("HOME", "/tmp"),
        ("PATH", "/usr/bin:/bin"),
        ("FUSE_OUT", "/out"),
        ("MPLBACKEND", "Agg"),
        ("MPLCONFIGDIR", "/tmp/matplotlib"),
        ("OPENBLAS_NUM_THREADS", "1"),
        ("OMP_NUM_THREADS", "1"),
        ("NUMEXPR_NUM_THREADS", "1"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("PYTHONUNBUFFERED", "1"),
    ] {
        c.args(["--setenv", key, value]);
    }
    c.args(["--chdir", "/package", "--", "/bin/sh", "-c"])
        .arg(format!(
            "ulimit -v {MEMORY_KB} && ulimit -f 65536 && exec /runtime/bin/python3 -I /bootstrap.py"
        ));
    Ok(c)
}

/// Bounded scan shared by the live scratch guard and final collection; links are never followed.
fn scan(out: &Path) -> Result<Vec<(String, PathBuf, u64)>, String> {
    let mut todo = vec![(out.to_owned(), 0usize)];
    let mut found = Vec::new();
    let mut entries = 0;
    let mut bytes = 0;
    while let Some((dir, depth)) = todo.pop() {
        for e in std::fs::read_dir(&dir).map_err(|_| "Couldn't inspect script output.")? {
            let e = e.map_err(|_| "Couldn't inspect script output.")?;
            entries += 1;
            if entries > 512 || depth > 8 {
                return Err("Script output exceeded its entry or depth limit.".into());
            }
            let meta = std::fs::symlink_metadata(e.path())
                .map_err(|_| "Couldn't inspect script output.")?;
            if meta.file_type().is_symlink() {
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            if meta.is_dir() {
                todo.push((e.path(), depth + 1));
            } else if meta.is_file() {
                bytes += meta.len();
                if bytes > SCRATCH_BYTES {
                    return Err("Script output exceeded its scratch limit.".into());
                }
                let rel = e
                    .path()
                    .strip_prefix(out)
                    .map_err(|_| "Invalid output path.")?
                    .to_string_lossy()
                    .replace('\\', "/");
                if portable_path(&rel).is_ok() {
                    found.push((rel, e.path(), meta.len()));
                }
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(found)
}

async fn claim_dispatch(
    ctx: &Ctx,
    r: &ScriptRequest,
    pkg: &Package,
    claim: &str,
    approved_task: &str,
) -> Result<(), String> {
    let pool = ctx.db.pool()?;
    let now = crate::sync::now();
    let sql = format!(
        "INSERT INTO skill_script_claims(id,workspace_id,user_id,run_id,version_id,script_sha256,state,created_at,updated_at) SELECT ?,?,?,?,?,?,'claimed',?,? FROM ({ELIGIBLE}) checked WHERE checked.sha256=? AND checked.task=? ON CONFLICT(id) DO NOTHING"
    );
    let inserted = sqlx::query(&sql)
        .bind(claim)
        .bind(crate::sync::WORKSPACE)
        .bind(crate::sync::USER)
        .bind(&r.run_id)
        .bind(&r.version_id)
        .bind(&pkg.script_sha256)
        .bind(now)
        .bind(now)
        .bind(&r.model_step_id)
        .bind(&r.version_id)
        .bind(&r.run_id)
        .bind(crate::sync::WORKSPACE)
        .bind(crate::sync::USER)
        .bind(&r.package_sha256)
        .bind(approved_task)
        .execute(&pool)
        .await
        .map_err(|_| "Couldn't record the script dispatch.")?;
    if inserted.rows_affected() != 1 {
        return Err("This script was already dispatched or its owner stopped. Inspect the run before asking for another execution.".into());
    }
    Ok(())
}

pub(crate) async fn run(
    ctx: &Ctx,
    r: ScriptRequest,
    on_event: Sink<ExecMsg>,
) -> Result<u32, String> {
    if !matches!(
        exec::sandbox_kind(),
        exec::SandboxKind::Bubblewrap | exec::SandboxKind::AppContainer
    ) {
        return Err("Skill scripts require the existing enabled OS sandbox.".into());
    }
    cleanup(&ctx.data_dir);
    let (pkg, claim, approved_task) = prepare(ctx, &r).await?;
    let runtime = ctx.data_dir.join("python-runtime");
    if crate::python_runtime::status(&runtime).is_none() {
        return Err("Install FUSE's pinned Python runtime before running a skill script.".into());
    }
    let root = runtime.join("python");
    let scratch = create_scratch(&ctx.data_dir, &claim, &pkg, &r.path, &r.args, &root)?;
    let pool = ctx.db.pool()?;
    claim_dispatch(ctx, &r, &pkg, &claim, &approved_task).await?;
    let id = ctx.execs.next_id.fetch_add(1, Ordering::Relaxed);
    let (stop_tx, stop_rx) = oneshot::channel();
    ctx.execs
        .running
        .lock()
        .map_err(|_| "Couldn't register the script stop control.")?
        .insert(id, stop_tx);
    let running = ctx.execs.running.clone();
    let timeout = Duration::from_secs(r.timeout_secs.unwrap_or(MAX_SECONDS));
    #[cfg(target_os = "linux")]
    let cmd = command(&root, &scratch.path)?;
    tokio::spawn(async move {
        let out = scratch.path.join("out");
        let guard_running = running.clone();
        let guard_out = out.clone();
        let monitor = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if scan(&guard_out).is_err() {
                    if let Ok(mut jobs) = guard_running.lock()
                        && let Some(stop) = jobs.remove(&id)
                    {
                        let _ = stop.send(());
                    }
                    break;
                }
            }
        });
        let mut done = None;
        let mut failed = false;
        let mut receive = |msg| match msg {
            ExecMsg::Done { .. } => done = Some(msg),
            ExecMsg::Error { message } => {
                failed = true;
                let _ = on_event.send(ExecMsg::Error {
                    message: message
                        .replace(scratch.path.to_string_lossy().as_ref(), "<skill scratch>"),
                });
            }
            other => {
                let _ = on_event.send(other);
            }
        };
        #[cfg(target_os = "linux")]
        exec::run_process(
            &scratch.path,
            cmd,
            Instant::now(),
            timeout,
            stop_rx,
            &mut receive,
        )
        .await;
        #[cfg(windows)]
        {
            let start = (|| -> Result<fuse_sandbox_win::Child, String> {
                use fuse_sandbox_win::{READ, WRITE, grant_to, plain};
                grant_to(scratch.container, &scratch.path, READ)
                    .map_err(|_| "Couldn't isolate package access.")?;
                grant_to(scratch.container, &root, READ)
                    .map_err(|_| "Couldn't isolate runtime access.")?;
                grant_to(scratch.container, &out, WRITE)
                    .map_err(|_| "Couldn't isolate output access.")?;
                let python = crate::python_runtime::python_exe(&root);
                let out_s = plain(&out).to_string_lossy().into_owned();
                let env = [
                    ("FUSE_OUT", out_s.as_str()),
                    ("MPLBACKEND", "Agg"),
                    ("OPENBLAS_NUM_THREADS", "1"),
                    ("OMP_NUM_THREADS", "1"),
                    ("NUMEXPR_NUM_THREADS", "1"),
                    ("PYTHONDONTWRITEBYTECODE", "1"),
                    ("PYTHONUNBUFFERED", "1"),
                ];
                fuse_sandbox_win::spawn_direct(
                    &fuse_sandbox_win::Spawn {
                        cwd: &scratch.path,
                        command: "",
                        network: false,
                        env_remove: &[],
                        container: scratch.container,
                        env_set: &env,
                        memory_bytes: Some(MEMORY_KB * 1024),
                        piped: false,
                        env_only: Some(&["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]),
                    },
                    &python,
                    &[
                        "-I".into(),
                        plain(&scratch.path.join("bootstrap.py"))
                            .to_string_lossy()
                            .into_owned(),
                    ],
                )
                .map_err(|e| format!("Couldn't start the isolated Python process: {e}"))
            })();
            match start {
                Ok(child) => {
                    exec::run_contained(child, Instant::now(), timeout, stop_rx, &mut receive).await
                }
                Err(message) => receive(ExecMsg::Error { message }),
            }
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = (root, timeout, stop_rx);
            receive(ExecMsg::Error {
                message: "Skill scripts aren't supported on this platform.".into(),
            });
        }
        monitor.abort();
        if let Ok(mut jobs) = running.lock() {
            jobs.remove(&id);
        }
        let (mut files, mut skipped, mut total) = (Vec::new(), Vec::new(), 0u64);
        match scan(&out) {
            Ok(found) => {
                for (path, file, size) in found {
                    if files.len() >= exec::MAX_OUT_FILES || total + size > exec::MAX_OUT_BYTES {
                        if skipped.len() < 128 {
                            skipped.push(path);
                        }
                        continue;
                    }
                    if let Ok(bytes) = std::fs::read(file) {
                        total += bytes.len() as u64;
                        files.push(OutFile { path, bytes });
                    }
                }
            }
            Err(message) => {
                failed = true;
                let _ = on_event.send(ExecMsg::Error { message });
            }
        }
        let code = match &done {
            Some(ExecMsg::Done { exit_code, .. }) => *exit_code,
            _ => None,
        };
        let state = if failed || code != Some(0) {
            "failed"
        } else {
            "complete"
        };
        let _ = sqlx::query(
            "UPDATE skill_script_claims SET state=?,exit_code=?,updated_at=? WHERE id=?",
        )
        .bind(state)
        .bind(code)
        .bind(crate::sync::now())
        .bind(&claim)
        .execute(&pool)
        .await;
        let _ = on_event.send(ExecMsg::Files { files, skipped });
        if let Some(msg) = done {
            let _ = on_event.send(msg);
        }
    });
    Ok(id)
}

pub mod commands {
    use super::*;
    #[tauri::command]
    pub async fn skill_python_run(
        ctx: tauri::State<'_, Ctx>,
        request: ScriptRequest,
        on_event: tauri::ipc::Channel<ExecMsg>,
    ) -> Result<u32, String> {
        run(&ctx, request, crate::ctx::channel_sink(on_event)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_package(script: &str) -> (String, String, Package) {
        let assets: Vec<Asset> = [
            ("SKILL.md", "Do the selected task."),
            ("data.txt", "support"),
            ("scripts/helper.py", "VALUE=42"),
            ("scripts/run.py", script),
        ]
        .into_iter()
        .map(|(path, text)| Asset {
            path: path.into(),
            bytes: text.len(),
            sha256: digest(text.as_bytes()),
            base64: encode64(text.as_bytes()),
        })
        .collect();
        let manifest = serde_json::to_string(&assets).unwrap();
        let hash = digest(manifest.as_bytes());
        let pkg = package(&manifest, "Do the selected task.", &hash, "scripts/run.py").unwrap();
        (manifest, hash, pkg)
    }
    fn fresh() -> PathBuf {
        let mut id = [0u8; 16];
        getrandom::fill(&mut id).unwrap();
        let path =
            std::env::temp_dir().join(format!("fuse-skill-test-{}", crate::sync::crypto::hex(&id)));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn integrity_paths_and_bounds_fail_closed() {
        let (manifest, hash, _) = fixture_package("print('ok')");
        assert!(package(&manifest, "Changed instructions.", &hash, "scripts/run.py").is_err());
        assert!(
            package(
                &manifest,
                "Do the selected task.",
                &"0".repeat(64),
                "scripts/run.py"
            )
            .is_err()
        );
        for path in [
            "../a.py",
            "/a.py",
            "C:/a.py",
            "data.txt",
            "missing.py",
            "scripts/CON.py",
            "scripts/a.py:ads",
            ".env/x.py",
        ] {
            assert!(
                package(&manifest, "Do the selected task.", &hash, path).is_err(),
                "{path}"
            );
        }
        for bad in ["Zg=Z", "Zh==", "Z===", "====", "ZA", "AA==AAAA"] {
            assert!(decode64(bad).is_err(), "{bad}");
        }
        for bytes in [b"".as_slice(), b"f", b"fo", b"foo", &[255, 0, 1, 128]] {
            assert_eq!(decode64(&encode64(bytes)).unwrap(), bytes);
        }
        let mut value: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        value[2]["base64"] = json!(encode64(b"print('tampered')"));
        let tampered = serde_json::to_string(&value).unwrap();
        assert!(
            package(
                &tampered,
                "Do the selected task.",
                &digest(tampered.as_bytes()),
                "scripts/run.py"
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn native_claims_are_atomic_owner_local_and_never_replayed() {
        use crate::keys::{Keys, MemoryStore};
        let dir = fresh();
        let ctx = Ctx::new(
            dir.join("data"),
            dir.join("config"),
            Keys::with_store(Box::<MemoryStore>::default()),
        );
        crate::db::db_open(&ctx).await.unwrap();
        let pool = ctx.db.pool().unwrap();
        let (manifest, hash, _) = fixture_package("print('ok')");
        let version = "00000000-0000-7000-8000-000000001603";
        let task = format!("/skill fixture@{version}\nRun it.");
        for (sql, params) in [
            (
                "INSERT INTO skills(id,workspace_id,user_id,name,created_at,updated_at) VALUES('script-skill',?,?,'fixture',1,1)",
                vec![json!(crate::sync::WORKSPACE), json!(crate::sync::USER)],
            ),
            (
                "INSERT INTO skill_versions(id,workspace_id,user_id,skill_id,instructions,assets,sha256,source,created_at,updated_at) VALUES(?,?,?,'script-skill','Do the selected task.',?,?,'fixture.zip',1,1)",
                vec![
                    json!(version),
                    json!(crate::sync::WORKSPACE),
                    json!(crate::sync::USER),
                    json!(manifest),
                    json!(hash),
                ],
            ),
            (
                "INSERT INTO runs(id,workspace_id,user_id,task,kind,mode,provider,model,status,cap_micro_usd,created_at,updated_at) VALUES('script-run',?,?,?,'code','ask','openai','fixture','running',1000,1,1)",
                vec![
                    json!(crate::sync::WORKSPACE),
                    json!(crate::sync::USER),
                    json!(task),
                ],
            ),
            (
                "INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,created_at,updated_at) VALUES('script-model',?,?,'script-run',1,'model',1,1)",
                vec![json!(crate::sync::WORKSPACE), json!(crate::sync::USER)],
            ),
        ] {
            db::execute(&pool, sql, &params).await.unwrap();
        }
        let r = ScriptRequest {
            run_id: "script-run".into(),
            model_step_id: "script-model".into(),
            call_id: "one".into(),
            version_id: version.into(),
            path: "scripts/run.py".into(),
            package_sha256: hash,
            args: vec![],
            timeout_secs: Some(30),
        };
        let (pkg, id, approved) = prepare(&ctx, &r).await.unwrap();
        let (a, b) = tokio::join!(
            claim_dispatch(&ctx, &r, &pkg, &id, &approved),
            claim_dispatch(&ctx, &r, &pkg, &id, &approved)
        );
        assert_ne!(a.is_ok(), b.is_ok());
        assert!(
            claim_dispatch(&ctx, &r, &pkg, &id, &approved)
                .await
                .is_err()
        );
        for update in [
            "UPDATE runs SET review_profile=1",
            "UPDATE runs SET mode='plan'",
            "UPDATE runs SET sync_owner='some-other-owner'",
            "UPDATE runs SET status='stopped'",
            "UPDATE runs SET task='No invocation'",
        ] {
            db::execute(&pool,"UPDATE runs SET review_profile=0,mode='ask',sync_owner=NULL,status='running',task=?",&[json!(task)]).await.unwrap();
            db::execute(&pool, update, &[]).await.unwrap();
            assert!(prepare(&ctx, &r).await.is_err(), "{update}");
        }
        db::execute(
            &pool,
            "UPDATE runs SET status='running',task=?",
            &[json!(task)],
        )
        .await
        .unwrap();
        let (_, _, approved) = prepare(&ctx, &r).await.unwrap();
        db::execute(&pool, "UPDATE runs SET mode='plan'", &[])
            .await
            .unwrap();
        assert!(
            claim_dispatch(&ctx, &r, &pkg, &"f".repeat(64), &approved)
                .await
                .is_err()
        );
        let pending = db::select(
            &pool,
            "SELECT payload FROM sync_outbox WHERE table_name='skill_script_claims'",
            &[],
        )
        .await
        .unwrap();
        assert!(pending.is_empty());
        db::execute(
            &pool,
            "DELETE FROM run_steps WHERE run_id='script-run'",
            &[],
        )
        .await
        .unwrap();
        db::execute(&pool, "DELETE FROM runs WHERE id='script-run'", &[])
            .await
            .unwrap();
        assert!(
            db::select(&pool, "SELECT id FROM skill_script_claims", &[])
                .await
                .unwrap()
                .is_empty()
        );
        drop(ctx);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn outputs_are_bounded_and_links_are_never_collected() {
        let root = fresh();
        std::fs::write(root.join("ok.txt"), "ok").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", root.join("linked.txt")).unwrap();
        assert_eq!(
            scan(&root)
                .unwrap()
                .iter()
                .map(|r| r.0.as_str())
                .collect::<Vec<_>>(),
            vec!["ok.txt"]
        );
        for n in 0..513 {
            std::fs::write(root.join(format!("{n}.txt")), []).unwrap();
        }
        assert!(scan(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "linux")]
    async fn execute(script: &str, timeout: u64, stop: bool) -> Vec<ExecMsg> {
        assert!(
            exec::bwrap_path().is_some(),
            "Install bubblewrap for the skill isolation tests"
        );
        let root = fresh();
        let (_, _, pkg) = fixture_package(script);
        let scratch = create_scratch(
            &root,
            &"a".repeat(64),
            &pkg,
            "scripts/run.py",
            &["literal; $(no-shell)".into()],
            Path::new("/usr"),
        )
        .unwrap();
        let cmd = command(Path::new("/usr"), &scratch.path).unwrap();
        let (tx, rx) = oneshot::channel();
        if stop {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let _ = tx.send(());
            });
        } else {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(15)).await;
                drop(tx);
            });
        }
        let mut events = vec![];
        exec::run_process(
            &scratch.path,
            cmd,
            Instant::now(),
            Duration::from_secs(timeout),
            rx,
            |m| events.push(m),
        )
        .await;
        drop(scratch);
        std::fs::remove_dir_all(root).unwrap();
        events
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn real_python_has_only_package_inputs_no_host_network_or_children() {
        let events=execute(r#"import os,sys,socket
assert sys.argv[1]=='literal; $(no-shell)'
from helper import VALUE
assert VALUE==42
assert open('/package/data.txt').read()=='support'
assert not os.path.exists('/home/daywalker')
assert not os.path.exists('/etc/passwd')
assert not os.path.exists('/proc/1/root/home/daywalker')
try:
    open('/package/data.txt','w').write('changed')
    raise AssertionError('writable package')
except OSError: pass
try:
    os.fork()
    raise AssertionError('fork permitted')
except OSError: pass
try:
    os.execv('/bin/sh',['sh','-c','exit 77'])
    raise AssertionError('executable replacement permitted')
except OSError: pass
try:
    socket.create_connection(('1.1.1.1',443),.1)
    raise AssertionError('network permitted')
except OSError: pass
open(os.path.join(os.environ['FUSE_OUT'],'result.txt'),'w').write('result')
assert 'FUSE_OUT' in os.environ
assert set(os.environ).issubset({'PATH','HOME','FUSE_OUT','MPLBACKEND','MPLCONFIGDIR','OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','NUMEXPR_NUM_THREADS','PYTHONDONTWRITEBYTECODE','PYTHONUNBUFFERED','PWD','LC_CTYPE'})
print('ISOLATION_OK')
"#,5,false).await;
        let output = events
            .iter()
            .filter_map(|e| {
                if let ExecMsg::Out { text } = e {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect::<String>();
        assert!(output.contains("ISOLATION_OK"), "{output}");
        assert!(events.iter().any(|e| matches!(
            e,
            ExecMsg::Done {
                exit_code: Some(0),
                ..
            }
        )));
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn timeout_stop_and_memory_are_enforced() {
        for (seconds, stop) in [(1, false), (5, true)] {
            let events = execute("import time\ntime.sleep(10)", seconds, stop).await;
            assert!(events.iter().any(
                |e| matches!(e,ExecMsg::Done{timed_out,stopped,..} if *timed_out || *stopped)
            ));
        }
        let events = execute("x=bytearray(800*1024*1024)", 5, false).await;
        assert!(
            events
                .iter()
                .any(|e| matches!(e,ExecMsg::Done{exit_code:Some(code),..} if *code!=0))
        );
    }
}
