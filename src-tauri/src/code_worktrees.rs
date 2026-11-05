//! Owner-local child worktrees. Fixed Git commands, raw objects (no checkout filters/hooks),
//! one durable delegation claim, and no integration into the parent's working tree.
use crate::{ctx::Ctx, db, repo};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;

const FILE_BYTES: usize = 16 * 1024 * 1024;
const TOTAL_BYTES: usize = 128 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const ELIGIBLE: &str = "r.parent_run_id IS NULL AND r.kind='code' AND r.mode IN('ask','auto_edit') AND r.review_profile=0 AND r.status='running' AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id)) AND (r.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.deleted_at IS NULL)) AND (r.thread_id IS NULL OR EXISTS(SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.deleted_at IS NULL AND t.project_id IS r.project_id)) AND NOT EXISTS(SELECT 1 FROM project_tools_off o WHERE o.workspace_id=r.workspace_id AND o.project_id=r.project_id AND o.tool='delegate_code')";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Base {
    pub commit: String,
    pub status_hash: String,
    pub folder_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub parent_id: String,
    pub model_step_id: String,
    pub call_id: String,
    pub base: Base,
    pub tasks: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Child {
    pub id: String,
    pub state: String,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn hash(bytes: &[u8]) -> String {
    crate::sync::crypto::hex(&Sha256::digest(bytes))
}
fn id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Couldn't create a child identity.")?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let s = crate::sync::crypto::hex(&bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    ))
}
fn fail(_: sqlx::Error) -> String {
    "Couldn't record child execution on this owner.".into()
}
fn linklike(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Never inherit Git override environment, use hooks, lazily fetch, invoke a pager or consult
/// an external filesystem monitor. Object reads are bounded and use resolved hashes only.
async fn git(root: &Path, args: &[&str], limit: usize) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new("git");
    // A fresh nonexistent directory cannot contain repository-supplied hooks on either OS.
    let hooks = format!(
        "core.hooksPath={}",
        std::env::temp_dir()
            .join(format!("fuse-no-hooks-{}", id()?))
            .display()
    );
    cmd.args([
        "--no-optional-locks",
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        &hooks,
        "-c",
        "core.pager=",
        "-c",
        "protocol.allow=never",
        "-c",
        "submodule.recurse=false",
    ])
    .args(args)
    .current_dir(root)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_NO_LAZY_FETCH", "1")
    .kill_on_drop(true);
    for key in [
        "FUSE_OPENAI_API_KEY",
        "FUSE_ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG",
        "GIT_EXTERNAL_DIFF",
    ] {
        cmd.env_remove(key);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd
        .spawn()
        .map_err(|_| "Git is unavailable on this execution owner.")?;
    let out = child.stdout.take().ok_or("Git stdout is unavailable.")?;
    let err = child.stderr.take().ok_or("Git stderr is unavailable.")?;
    tokio::time::timeout(Duration::from_secs(15),async {
        let(mut output,mut errors)=(Vec::new(),Vec::new());
        let mut out=out.take((limit+1) as u64);let mut err=err.take(8193);
        let (a,b)=tokio::join!(out.read_to_end(&mut output),err.read_to_end(&mut errors));
        a.map_err(|_|"Couldn't read a Git object.")?;b.map_err(|_|"Couldn't read Git status.")?;
        if output.len()>limit || errors.len()>8192 { return Err("Child worktree setup exceeded its Git output limit.".into()); }
        if !child.wait().await.map_err(|_|"Git setup was interrupted.")?.success() { return Err("Git refused child worktree setup. Its worktree and dispatch evidence are retained.".into()); }
        Ok(output)
    }).await.map_err(|_|"Git worktree setup exceeded its operation limit.")?
}

async fn parent(
    ctx: &Ctx,
    parent_id: &str,
) -> Result<(serde_json::Value, PathBuf, String), String> {
    if crate::exec::sandbox_kind() == crate::exec::SandboxKind::None {
        return Err("Parallel Code requires the existing OS command sandbox to be enabled.".into());
    }
    let sql = format!(
        "SELECT r.*,f.path AS folder_path,f.id AS folder_id FROM runs r JOIN run_folders rf ON rf.run_id=r.id AND rf.workspace_id=r.workspace_id AND rf.user_id=r.user_id AND rf.ordinal=0 JOIN folders f ON f.id=rf.folder_id AND f.workspace_id=r.workspace_id AND f.user_id=r.user_id WHERE r.id=? AND r.workspace_id=? AND r.user_id=? AND {ELIGIBLE}"
    );
    let rows = db::select(
        &ctx.db.pool()?,
        &sql,
        &[
            json!(parent_id),
            json!(crate::sync::WORKSPACE),
            json!(crate::sync::USER),
        ],
    )
    .await?;
    let row=rows.into_iter().next().ok_or("This owner cannot delegate that run. Use a writable, non-review Code run with a linked Git repository.")?;
    let root = std::fs::canonicalize(
        row["folder_path"]
            .as_str()
            .ok_or("Missing parent folder.")?,
    )
    .map_err(|_| "The parent repository is missing.")?;
    let folder = row["folder_id"]
        .as_str()
        .ok_or("Missing parent folder identity.")?
        .to_owned();
    Ok((serde_json::Value::Object(row), root, folder))
}
pub async fn base(ctx: &Ctx, parent_id: String) -> Result<Base, String> {
    let (_, root, folder_id) = parent(ctx, &parent_id).await?;
    let commit =
        String::from_utf8(git(&root, &["rev-parse", "--verify", "HEAD^{commit}"], 128).await?)
            .map_err(|_| "Invalid Git revision.")?
            .trim()
            .to_owned();
    if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("The repository has no committed base for child worktrees.".into());
    }
    // `status` may execute clean filters. List names without conversion and fingerprint only
    // metadata, including tracked deletions. Never read secret-looking working-tree bytes.
    let names = git(
        &root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        2 * 1024 * 1024,
    )
    .await?;
    let mut status = BTreeSet::new();
    for raw in names.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        if status.len() >= MAX_FILES {
            return Err("Parallel setup supports at most 10,000 visible files.".into());
        }
        let path = std::str::from_utf8(raw).map_err(|_| "Parallel setup needs UTF-8 filenames.")?;
        if !safe_path(path) {
            return Err("Parallel setup needs portable paths.".into());
        }
        let metadata = std::fs::symlink_metadata(root.join(path)).ok();
        let stamp = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|t| t.as_nanos())
            .unwrap_or(0);
        status.insert(format!(
            "{path}\0{}\0{stamp}\0{}",
            metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            metadata
                .as_ref()
                .is_some_and(|m| m.file_type().is_symlink())
        ));
    }
    Ok(Base {
        commit,
        status_hash: hash(
            &serde_json::to_vec(&status).map_err(|_| "Couldn't fingerprint parent metadata.")?,
        ),
        folder_id,
    })
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '\0'])
        && !path.chars().any(char::is_control)
        && path.split('/').all(|p| {
            !matches!(p, "" | "." | "..")
                && !p.eq_ignore_ascii_case(".git")
                && !p.ends_with(['.', ' '])
        })
}

/// Materialize raw blobs rather than checkout: repository filters and hooks never execute.
/// Secret-looking paths remain absent and skip-worktree, so a later approved commit does not
/// stage their removal. Symlinks/submodules fail closed before reading their content.
async fn materialize(root: &Path, revision: &str) -> Result<(), String> {
    let started = Instant::now();
    let listing = git(
        root,
        &["ls-tree", "-r", "-z", "--long", revision],
        2 * 1024 * 1024,
    )
    .await?;
    let mut paths = BTreeSet::new();
    let mut total = 0usize;
    let mut entries = Vec::new();
    for raw in listing.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        if entries.len() >= MAX_FILES {
            return Err("Child setup supports at most 10,000 tracked files.".into());
        }
        let line =
            std::str::from_utf8(raw).map_err(|_| "Child setup needs portable UTF-8 filenames.")?;
        let (meta, path) = line.split_once('\t').ok_or("Invalid Git tree entry.")?;
        let parts: Vec<_> = meta.split_whitespace().collect();
        if parts.len() != 4
            || !matches!(parts[0], "100644" | "100755")
            || parts[1] != "blob"
            || !safe_path(path)
            || !paths.insert(path.to_lowercase())
        {
            return Err("Child setup refuses links, submodules or nonportable/colliding paths. The worktree is retained.".into());
        }
        let size = parts[3]
            .parse::<usize>()
            .map_err(|_| "Invalid Git object size.")?;
        if size > FILE_BYTES || total.saturating_add(size) > TOTAL_BYTES {
            return Err("Child setup is limited to 16 MiB per file and 128 MiB total.".into());
        }
        total += size;
        entries.push((
            parts[0].to_owned(),
            parts[2].to_owned(),
            path.to_owned(),
            size,
        ));
    }
    for (mode, oid, path, size) in entries {
        if started.elapsed() > Duration::from_secs(60) {
            return Err(
                "Child worktree setup exceeded its one-minute limit. Evidence is retained.".into(),
            );
        }
        if path.split('/').any(repo::is_secret) {
            git(
                root,
                &["update-index", "--skip-worktree", "--", &path],
                8192,
            )
            .await?;
            continue;
        }
        let bytes = git(root, &["cat-file", "blob", &oid], FILE_BYTES).await?;
        if bytes.len() != size {
            return Err("A child Git object changed size.".into());
        }
        let target = root.join(&path);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|_| "Couldn't create a child directory.")?;
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| "A child path already exists or is not portable.")?;
        std::io::Write::write_all(&mut file, &bytes)
            .map_err(|_| "Couldn't materialize a child file.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                &target,
                std::fs::Permissions::from_mode(if mode == "100755" { 0o700 } else { 0o600 }),
            )
            .map_err(|_| "Couldn't set child file permissions.")?;
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    Ok(())
}

async fn children(ctx: &Ctx, parent_id: &str, dispatch: &str) -> Result<Vec<Child>, String> {
    let rows=db::select(&ctx.db.pool()?,"SELECT child_id,state FROM code_children WHERE workspace_id=? AND user_id=? AND parent_id=? AND dispatch_id=? ORDER BY ordinal",&[json!(crate::sync::WORKSPACE),json!(crate::sync::USER),json!(parent_id),json!(dispatch)]).await?;
    rows.into_iter()
        .map(|r| {
            Ok(Child {
                id: r["child_id"]
                    .as_str()
                    .ok_or("Invalid child identity.")?
                    .into(),
                state: r["state"].as_str().ok_or("Invalid child state.")?.into(),
            })
        })
        .collect()
}

/// History and stale approvals never confer the original child's folder authority.
pub async fn folder_guard(pool: &sqlx::SqlitePool, folder_id: &str) -> Result<bool, String> {
    let related:Option<i64>=sqlx::query_scalar("SELECT 1 FROM run_folders rf JOIN runs r ON r.id=rf.run_id AND r.workspace_id=rf.workspace_id WHERE rf.folder_id=? AND r.parent_run_id IS NOT NULL LIMIT 1")
        .bind(folder_id).fetch_optional(pool).await.map_err(fail)?;
    if related.is_none() {
        return Ok(false);
    }
    let sql = format!(
        "SELECT 1 FROM code_children c JOIN runs leaf ON leaf.id=c.child_id AND leaf.workspace_id=c.workspace_id AND leaf.user_id=c.user_id JOIN runs r ON r.id=c.parent_id AND r.workspace_id=c.workspace_id AND r.user_id=c.user_id WHERE c.folder_id=? AND c.state='running' AND leaf.status='running' AND leaf.parent_run_id=r.id AND leaf.project_id IS r.project_id AND leaf.thread_id IS r.thread_id AND (leaf.sync_owner IS NULL OR leaf.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=leaf.workspace_id)) AND {ELIGIBLE}"
    );
    let allowed: Option<i64> = sqlx::query_scalar(&sql)
        .bind(folder_id)
        .fetch_optional(pool)
        .await
        .map_err(fail)?;
    if allowed.is_none() {
        return Err("This child worktree is not executing on its owner. Use the parent's read-only review controls.".into());
    }
    Ok(true)
}

/// Recheck per-tool revocation while the child command is live.
pub(crate) async fn command_allowed(
    pool: &sqlx::SqlitePool,
    folder_id: &str,
) -> Result<bool, String> {
    if !folder_guard(pool, folder_id).await? {
        return Ok(false);
    }
    let denied:i64=sqlx::query_scalar("SELECT COUNT(*) FROM code_children c JOIN runs r ON r.id=c.parent_id AND r.workspace_id=c.workspace_id JOIN project_tools_off o ON o.workspace_id=r.workspace_id AND o.project_id=r.project_id AND o.tool='run_command' WHERE c.folder_id=?")
        .bind(folder_id).fetch_one(pool).await.map_err(fail)?;
    Ok(denied == 0)
}

fn within_worktree_budget(root: &Path) -> bool {
    let mut todo = vec![(root.to_owned(), 0)];
    let mut count = 0usize;
    let mut bytes = 0u64;
    while let Some((dir, depth)) = todo.pop() {
        if depth > 32 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries {
            count += 1;
            if count > 20_000 {
                return false;
            }
            let Ok(entry) = entry else {
                return false;
            };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                return false;
            };
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
                todo.push((entry.path(), depth + 1));
            } else {
                bytes = bytes.saturating_add(meta.len());
            }
            if bytes > 512 * 1024 * 1024 {
                return false;
            }
        }
    }
    true
}

/// Guard both durable authority and bounded worktree growth independently of a browser.
/// This is a monitored bound, not a filesystem quota; transient overshoot is possible.
#[allow(clippy::too_many_arguments)] // Same command supervisor inputs plus its owner-local scope.
pub async fn run_command(
    pool: &sqlx::SqlitePool,
    folder_id: &str,
    root: &Path,
    command: &str,
    timeout: Duration,
    mut stop: tokio::sync::oneshot::Receiver<()>,
    sandbox: &crate::exec::Sandbox,
    on: &crate::ctx::Sink<crate::exec::ExecMsg>,
) {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut sender = Some(sender);
    let task = crate::exec::run(root, command, timeout, receiver, Some(sandbox), |m| {
        let _ = on.send(m);
    });
    tokio::pin!(task);
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let mut scans = 0u32;
    loop {
        tokio::select! {
            _=&mut task=>break,
            _=&mut stop=>{if let Some(sender)=sender.take(){let _=sender.send(());}task.await;break;},
            _=tick.tick()=>{
                scans+=1;
                let allowed=command_allowed(pool,folder_id).await.unwrap_or(false);
                let bounded=!scans.is_multiple_of(4)||within_worktree_budget(root);
                if !allowed||!bounded {
                    let text=if !allowed{"Child command stopped because its owner, parent or permissions changed."}else{"Child command stopped at its 512 MiB / 20,000-entry worktree limit. Inspect the retained worktree."};
                    let _=on.send(crate::exec::ExecMsg::Out{text:format!("\n{text}\n")});
                    if let Some(sender)=sender.take(){let _=sender.send(());}task.await;break;
                }
            }
        }
    }
}

/// Global deletion removes only app-owned UUID worktrees. Never follow their Git pointers:
/// repository objects and stale Git administrative entries retain their separate policy.
pub(crate) fn wipe_worktrees(data: &Path) -> Result<(), String> {
    let base = data.join("code-worktrees");
    if linklike(&base) {
        return Err(
            "The private worktree store is a link; no external directory was removed.".into(),
        );
    }
    let entries = match std::fs::read_dir(&base) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Couldn't inspect private worktrees for deletion.".into()),
    };
    for entry in entries {
        let entry = entry.map_err(|_| "Couldn't inspect a private worktree.")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.len() != 36
            || !name.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            })
        {
            continue;
        }
        let meta = std::fs::symlink_metadata(entry.path())
            .map_err(|_| "Couldn't inspect private worktree metadata.")?;
        if linklike(&entry.path()) {
            #[cfg(windows)]
            let directory_link = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & 0x10 != 0
            };
            #[cfg(not(windows))]
            let directory_link = false;
            (if directory_link {
                std::fs::remove_dir(entry.path())
            } else {
                std::fs::remove_file(entry.path())
            })
            .map_err(|_| "Couldn't remove a private worktree link.")?;
        } else if meta.is_dir() {
            std::fs::remove_dir_all(entry.path()).map_err(
                |_| "Couldn't remove a private worktree. Stop its commands and retry deletion.",
            )?;
        }
    }
    cleanup_commands(data);
    Ok(())
}

pub async fn prepare(ctx: &Ctx, request: Request) -> Result<Vec<Child>, String> {
    if request.tasks.is_empty()
        || request.tasks.len() > 3
        || request
            .tasks
            .iter()
            .any(|t| t.trim().is_empty() || t.len() > 16 * 1024 || t.contains('\0'))
        || request.tasks.iter().map(String::len).sum::<usize>() > 32 * 1024
        || request.call_id.is_empty()
        || request.call_id.len() > 256
    {
        return Err("Delegate one to three explicit tasks, bounded to 32 KiB total.".into());
    }
    let encoded = serde_json::to_string(&request).map_err(|_| "Invalid child request.")?;
    let dispatch = hash(
        format!(
            "{}\0{}\0{}",
            request.parent_id, request.model_step_id, request.call_id
        )
        .as_bytes(),
    );
    let prior=db::select(&ctx.db.pool()?,"SELECT request FROM code_children WHERE workspace_id=? AND parent_id=? AND dispatch_id=? LIMIT 1",&[json!(crate::sync::WORKSPACE),json!(request.parent_id),json!(dispatch)]).await?;
    if let Some(row) = prior.first() {
        if row["request"].as_str() != Some(&encoded) {
            return Err(
                "A delegation identity was reused with different tasks. Nothing was started."
                    .into(),
            );
        }
        return children(ctx, &request.parent_id, &dispatch).await;
    }
    if base(ctx, request.parent_id.clone()).await? != request.base {
        return Err("The parent repository changed after review. Review a fresh delegation before starting.".into());
    }
    let (parent_row, root, _) = parent(ctx, &request.parent_id).await?;
    let owner_dir = ctx.data_dir.join("code-worktrees");
    if linklike(&owner_dir) {
        return Err("The child worktree store cannot be a link.".into());
    }
    std::fs::create_dir_all(&owner_dir).map_err(|_| "Couldn't create private child storage.")?;
    let owner_dir =
        std::fs::canonicalize(owner_dir).map_err(|_| "Couldn't resolve private child storage.")?;
    let pool = ctx.db.pool()?;
    let mut tx = pool.begin().await.map_err(fail)?;
    // First write obtains SQLite's writer lock before counting children. Every child relation
    // and request is committed before any filesystem or paid operation can be dispatched.
    let sql = format!(
        "UPDATE runs AS r SET updated_at=updated_at WHERE r.id=? AND r.workspace_id=? AND r.user_id=? AND {ELIGIBLE} AND EXISTS(SELECT 1 FROM run_steps s WHERE s.id=? AND s.run_id=r.id AND s.workspace_id=r.workspace_id AND s.user_id=r.user_id AND s.kind='model' AND s.seq=(SELECT MAX(seq) FROM run_steps WHERE run_id=r.id AND kind='model'))"
    );
    let eligible = sqlx::query(&sql)
        .bind(&request.parent_id)
        .bind(crate::sync::WORKSPACE)
        .bind(crate::sync::USER)
        .bind(&request.model_step_id)
        .execute(&mut *tx)
        .await
        .map_err(fail)?;
    if eligible.rows_affected() != 1 {
        return Err("The approved parent/model step is no longer executable here.".into());
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM code_children WHERE workspace_id=? AND parent_id=?",
    )
    .bind(crate::sync::WORKSPACE)
    .bind(&request.parent_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(fail)?;
    if count != 0 {
        return Err("This run already delegated its children. Review their retained results; a repeated call cannot launch more work.".into());
    }
    let stamp = now();
    let mut planned = Vec::new();
    let task = parent_row["task"].as_str().ok_or("Missing parent task.")?;
    let pins = task
        .trim_start()
        .lines()
        .take_while(|l| l.starts_with("/skill "))
        .take(3)
        .collect::<Vec<_>>()
        .join("\n");
    for (ordinal, task) in request.tasks.iter().enumerate() {
        let child = id()?;
        let folder = id()?;
        let path = owner_dir.join(&child);
        let branch = format!("fuse/child/{child}");
        let task = format!(
            "{pins}\nChild task approved through the parent run. Work only in your own branch/worktree. Use file tools and approved commands. Do not delegate or use Git directly. Review, commits and integration happen through the parent controls.\n\n{task}"
        );
        sqlx::query("INSERT INTO runs(id,workspace_id,user_id,project_id,thread_id,message_id,task,kind,mode,provider,model,status,cap_micro_usd,created_at,updated_at,started_at,branch,planner,sync_owner,routing_stage,parent_run_id) SELECT ?,workspace_id,user_id,project_id,thread_id,message_id,?,'code',mode,provider,model,'paused',cap_micro_usd,?,?,?, ?,planner,sync_owner,'work',id FROM runs WHERE id=? AND workspace_id=?")
            .bind(&child).bind(task).bind(stamp).bind(stamp).bind(stamp).bind(&branch).bind(&request.parent_id).bind(crate::sync::WORKSPACE).execute(&mut *tx).await.map_err(fail)?;
        sqlx::query("INSERT INTO code_children(child_id,workspace_id,user_id,parent_id,dispatch_id,model_step_id,call_id,request,ordinal,parent_folder_id,base_revision,path,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'creating',?,?)")
            .bind(&child).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(&request.parent_id).bind(&dispatch).bind(&request.model_step_id).bind(&request.call_id).bind(&encoded).bind(ordinal as i64).bind(&request.base.folder_id).bind(&request.base.commit).bind(path.to_string_lossy().as_ref()).bind(stamp).bind(stamp).execute(&mut *tx).await.map_err(fail)?;
        planned.push((child, folder, path, branch));
    }
    tx.commit().await.map_err(fail)?;
    for (child, folder, path, branch) in planned {
        let result:Result<(),String>=async {
            if base(ctx,request.parent_id.clone()).await?!=request.base {return Err("The parent changed or stopped during preparation. Child worktree evidence is retained.".into());}
            let path_text=path.to_str().ok_or("Child storage needs a UTF-8 path.")?;
            git(&root,&["worktree","add","--no-checkout","-b",&branch,"--",path_text,&request.base.commit],8192).await?;
            git(&path,&["read-tree",&request.base.commit],8192).await?;
            materialize(&path,&request.base.commit).await?;
            let pointer=std::fs::read(path.join(".git")).map_err(|_|"Couldn't pin the child Git pointer.")?;
            let git_dir=String::from_utf8(git(&path,&["rev-parse","--absolute-git-dir"],8192).await?).map_err(|_|"Invalid child Git metadata path.")?;
            parent(ctx,&request.parent_id).await?;
            let mut tx=pool.begin().await.map_err(fail)?;
            sqlx::query("INSERT INTO folders(id,workspace_id,user_id,path,read_sensitive,created_at,updated_at) VALUES(?,?,?,?,0,?,?)").bind(&folder).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(path_text).bind(stamp).bind(stamp).execute(&mut *tx).await.map_err(fail)?;
            sqlx::query("INSERT INTO run_folders(id,workspace_id,user_id,run_id,folder_id,label,ordinal,created_at) VALUES(?,?,?,?,?,'child',0,?)").bind(format!("child-folder-{child}")).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(&child).bind(&folder).bind(stamp).execute(&mut *tx).await.map_err(fail)?;
            let ready=sqlx::query("UPDATE code_children SET folder_id=?,git_dir=?,git_pointer_sha256=?,state='ready',updated_at=? WHERE child_id=? AND state='creating'").bind(&folder).bind(git_dir.trim()).bind(hash(&pointer)).bind(now()).bind(&child).execute(&mut *tx).await.map_err(fail)?;
            if ready.rows_affected()!=1 {return Err("The child stopped during preparation. Worktree evidence is retained without a folder grant.".into());}
            tx.commit().await.map_err(fail)?;Ok(())
        }.await;
        if let Err(error) = result {
            db::batch(
                &pool,
                &[
                    db::Statement {
                        sql:
                            "UPDATE code_children SET state='failed',updated_at=? WHERE child_id=?"
                                .into(),
                        params: vec![json!(now()), json!(child)],
                    },
                    db::Statement {
                        sql: "UPDATE runs SET status='error',note=?,updated_at=? WHERE id=?".into(),
                        params: vec![json!(error), json!(now()), json!(child)],
                    },
                ],
            )
            .await?;
        }
    }
    children(ctx, &request.parent_id, &dispatch).await
}

pub mod commands {
    use super::*;
    #[tauri::command]
    pub async fn code_worktree_base(
        ctx: tauri::State<'_, Ctx>,
        parent_id: String,
    ) -> Result<Base, String> {
        base(&ctx, parent_id).await
    }
    #[tauri::command]
    pub async fn code_worktree_prepare(
        ctx: tauri::State<'_, Ctx>,
        request: Request,
    ) -> Result<Vec<Child>, String> {
        prepare(&ctx, request).await
    }
}

#[cfg(windows)]
pub(crate) struct CommandGrant {
    pub container: fuse_sandbox_win::Container,
    root: PathBuf,
    marker: PathBuf,
}
#[cfg(windows)]
impl CommandGrant {
    pub fn new(root: &Path) -> Result<Self, String> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| "Couldn't create a private command identity.")?;
        let nonce = u128::from_be_bytes(random);
        let store = root
            .parent()
            .ok_or("Missing child store.")?
            .join(".command-grants");
        if linklike(&store) {
            return Err("Private command metadata cannot be a link.".into());
        }
        std::fs::create_dir_all(&store).map_err(|_| "Couldn't record command cleanup.")?;
        let grant = Self {
            container: fuse_sandbox_win::Container::CodeChild(nonce),
            root: root.to_owned(),
            marker: store.join(format!("{nonce:032x}")),
        };
        std::fs::write(
            &grant.marker,
            serde_json::to_vec(&json!({"root":root}))
                .map_err(|_| "Invalid child cleanup metadata.")?,
        )
        .map_err(|_| "Couldn't record child cleanup.")?;
        if !fuse_sandbox_win::grant_to(grant.container, root, fuse_sandbox_win::WRITE)
            .map_err(|_| "Couldn't grant the private child worktree.")?
        {
            return Err("The filesystem couldn't provide the private child grant.".into());
        }
        Ok(grant)
    }
}
#[cfg(windows)]
impl Drop for CommandGrant {
    fn drop(&mut self) {
        let _ = fuse_sandbox_win::revoke_from(self.container, &self.root);
        let _ = fuse_sandbox_win::remove_profile_of(self.container);
        let _ = std::fs::remove_file(&self.marker);
    }
}

/// Expired invocation profiles only; active commands last at most ten minutes. Ctx views may
/// be created while execution is active, so startup must never revoke a live grant.
pub(crate) fn cleanup_commands(data: &Path) {
    #[cfg(windows)]
    {
        let base = data.join("code-worktrees");
        let store = base.join(".command-grants");
        if linklike(&base) || linklike(&store) {
            return;
        }
        let Ok(entries) = std::fs::read_dir(store) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if name.len() != 32
                || !name.bytes().all(|b| b.is_ascii_hexdigit())
                || !meta.is_file()
                || meta.file_type().is_symlink()
                || !meta
                    .modified()
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(660))
            {
                continue;
            }
            let Ok(nonce) = u128::from_str_radix(name, 16) else {
                continue;
            };
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                continue;
            };
            let Some(path) = value["root"].as_str().map(PathBuf::from) else {
                continue;
            };
            if path.parent() != Some(base.as_path()) || linklike(&path) {
                continue;
            }
            let container = fuse_sandbox_win::Container::CodeChild(nonce);
            let _ = fuse_sandbox_win::revoke_from(container, &path);
            let _ = fuse_sandbox_win::remove_profile_of(container);
            let _ = std::fs::remove_file(entry.path());
        }
    }
    #[cfg(not(windows))]
    let _ = data;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{Keys, MemoryStore};
    struct Fixture {
        dir: PathBuf,
        root: PathBuf,
        ctx: Ctx,
    }
    impl Fixture {
        fn git(&self, args: &[&str]) -> String {
            let result = std::process::Command::new("git")
                .args([
                    "-c",
                    "user.name=Recorded child",
                    "-c",
                    "user.email=child@example.invalid",
                ])
                .args(args)
                .current_dir(&self.root)
                .output()
                .unwrap();
            assert!(result.status.success(), "fixture Git failed: {args:?}");
            String::from_utf8(result.stdout).unwrap().trim().into()
        }
        async fn new() -> Self {
            #[cfg(windows)]
            crate::exec::commands::sandbox_windows_set(true);
            assert_ne!(
                crate::exec::sandbox_kind(),
                crate::exec::SandboxKind::None,
                "Native worktree tests require the real OS sandbox; do not silently skip."
            );
            let dir = std::env::temp_dir().join(format!("fuse-child-test-{}", id().unwrap()));
            let root = dir.join("repo");
            std::fs::create_dir_all(&root).unwrap();
            let ctx = Ctx::new(
                dir.join("data"),
                dir.join("config"),
                Keys::with_store(Box::<MemoryStore>::default()),
            );
            db::db_open(&ctx).await.unwrap();
            let f = Self { dir, root, ctx };
            f.git(&["init", "--initial-branch=fixture"]);
            std::fs::write(f.root.join("notes.txt"), "committed base\n").unwrap();
            std::fs::write(f.root.join("credentials.json"), "inert synthetic fixture\n").unwrap();
            std::fs::write(f.root.join(".gitattributes"), "*.txt filter=fixture\n").unwrap();
            f.git(&[
                "add",
                "--",
                "notes.txt",
                "credentials.json",
                ".gitattributes",
            ]);
            f.git(&["commit", "-m", "Recorded base"]);
            let pool = f.ctx.db.pool().unwrap();
            for (sql, params) in [
                (
                    "INSERT INTO folders(id,workspace_id,user_id,path,created_at,updated_at) VALUES('parent-folder',?,?,?,1,1)",
                    vec![
                        json!(crate::sync::WORKSPACE),
                        json!(crate::sync::USER),
                        json!(f.root),
                    ],
                ),
                (
                    "INSERT INTO runs(id,workspace_id,user_id,task,kind,mode,provider,model,status,cap_micro_usd,created_at,updated_at) VALUES('parent',?,?,'Approved parent','code','ask','openai','fixture','running',1000,1,1)",
                    vec![json!(crate::sync::WORKSPACE), json!(crate::sync::USER)],
                ),
                (
                    "INSERT INTO run_folders(id,workspace_id,user_id,run_id,folder_id,label,ordinal,created_at) VALUES('parent-link',?,?,'parent','parent-folder','repo',0,1)",
                    vec![json!(crate::sync::WORKSPACE), json!(crate::sync::USER)],
                ),
                (
                    "INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,created_at,updated_at) VALUES('model-step',?,?,'parent',1,'model',1,1)",
                    vec![json!(crate::sync::WORKSPACE), json!(crate::sync::USER)],
                ),
            ] {
                db::execute(&pool, sql, &params).await.unwrap();
            }
            f
        }
        async fn request(&self) -> Request {
            Request {
                parent_id: "parent".into(),
                model_step_id: "model-step".into(),
                call_id: "delegate-one".into(),
                base: base(&self.ctx, "parent".into()).await.unwrap(),
                tasks: vec!["First explicit task".into(), "Second explicit task".into()],
            }
        }
        async fn rows(&self, sql: &str) -> Vec<serde_json::Map<String, serde_json::Value>> {
            db::select(&self.ctx.db.pool().unwrap(), sql, &[])
                .await
                .unwrap()
        }
        async fn close(self) {
            self.ctx.db.pool().unwrap().close().await;
            #[cfg(windows)]
            {
                // Git marks its object files read-only on Windows. Clear only our disposable
                // fixture's file attributes, never an installed user's repository permissions.
                #[allow(clippy::permissions_set_readonly_false)]
                fn writable(dir: &Path) {
                    for entry in std::fs::read_dir(dir).unwrap().flatten() {
                        let path = entry.path();
                        let meta = std::fs::symlink_metadata(&path).unwrap();
                        if meta.is_dir() && !linklike(&path) {
                            writable(&path);
                        }
                        let mut permissions = meta.permissions();
                        if permissions.readonly() {
                            permissions.set_readonly(false);
                            std::fs::set_permissions(path, permissions).unwrap();
                        }
                    }
                }
                writable(&self.dir);
            }
            std::fs::remove_dir_all(self.dir).unwrap();
        }
    }
    #[tokio::test]
    async fn raw_worktrees_preserve_dirty_parent_exclude_secrets_and_never_run_filters_or_hooks() {
        let f = Fixture::new().await;
        std::fs::write(f.root.join("notes.txt"), "uncommitted parent\n").unwrap();
        let index = std::fs::read(f.root.join(".git/index")).unwrap();
        f.git(&["config", "filter.fixture.required", "true"]);
        f.git(&[
            "config",
            "filter.fixture.clean",
            "fuse-filter-must-never-run",
        ]);
        f.git(&[
            "config",
            "filter.fixture.smudge",
            "fuse-filter-must-never-run",
        ]);
        let hooks = f.root.join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        for name in ["post-checkout", "post-index-change"] {
            let hook = hooks.join(name);
            std::fs::write(&hook, "#!/bin/sh\nprintf hook > hook-ran\nexit 99\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        let request = f.request().await;
        let children = prepare(&f.ctx, request.clone()).await.unwrap();
        assert_eq!(children.len(), 2);
        assert!(children.iter().all(|c| c.state == "ready"), "{children:?}");
        let paths=f.rows("SELECT c.path,c.folder_id,r.parent_run_id,r.status,f.read_sensitive FROM code_children c JOIN runs r ON r.id=c.child_id JOIN folders f ON f.id=c.folder_id ORDER BY c.ordinal").await;
        for row in &paths {
            let path = PathBuf::from(row["path"].as_str().unwrap());
            assert_eq!(
                std::fs::read_to_string(path.join("notes.txt")).unwrap(),
                "committed base\n"
            );
            assert!(!path.join("credentials.json").exists());
            assert!(!path.join("hook-ran").exists());
            assert_eq!(row["parent_run_id"], "parent");
            assert_eq!(row["status"], "paused");
            assert_eq!(row["read_sensitive"], 0);
        }
        assert_ne!(paths[0]["folder_id"], paths[1]["folder_id"]);
        assert_eq!(
            std::fs::read_to_string(f.root.join("notes.txt")).unwrap(),
            "uncommitted parent\n"
        );
        assert_eq!(std::fs::read(f.root.join(".git/index")).unwrap(), index);
        assert!(!f.root.join("hook-ran").exists());
        let repeated = prepare(&f.ctx, request).await.unwrap();
        assert_eq!(children[0].id, repeated[0].id);
        assert_eq!(f.rows("SELECT id FROM runs").await.len(), 3);
        assert_eq!(f.rows("SELECT id FROM request_log").await.len(), 0);
        assert_eq!(
            f.rows("SELECT id FROM project_folders UNION ALL SELECT id FROM thread_folders")
                .await
                .len(),
            0
        );
        f.close().await;
    }
    #[tokio::test]
    async fn duplicate_concurrent_preparation_cannot_create_additional_children() {
        let f = Fixture::new().await;
        let request = f.request().await;
        let (a, b) = tokio::join!(prepare(&f.ctx, request.clone()), prepare(&f.ctx, request));
        assert!(a.is_ok() || b.is_ok());
        assert_eq!(f.rows("SELECT child_id FROM code_children").await.len(), 2);
        assert_eq!(f.rows("SELECT id FROM runs").await.len(), 3);
        let mut next = f.request().await;
        next.call_id = "different-model-call".into();
        assert!(prepare(&f.ctx, next).await.is_err());
        assert_eq!(f.rows("SELECT child_id FROM code_children").await.len(), 2);
        f.close().await;
    }
    #[tokio::test]
    async fn stale_scope_revision_or_model_step_creates_no_worktree_or_run() {
        let f = Fixture::new().await;
        let request = f.request().await;
        std::fs::write(f.root.join("new.txt"), "parent changed").unwrap();
        assert!(prepare(&f.ctx, request).await.is_err());
        std::fs::remove_file(f.root.join("new.txt")).unwrap();
        let mut stale = f.request().await;
        stale.model_step_id = "not-the-recorded-step".into();
        assert!(prepare(&f.ctx, stale).await.is_err());
        let pool = f.ctx.db.pool().unwrap();
        for sql in [
            "UPDATE runs SET mode='plan' WHERE id='parent'",
            "UPDATE runs SET mode='ask',kind='work' WHERE id='parent'",
            "UPDATE runs SET kind='code',review_profile=1 WHERE id='parent'",
            "UPDATE runs SET review_profile=0,sync_owner='another-device' WHERE id='parent'",
        ] {
            db::execute(&pool, sql, &[]).await.unwrap();
            assert!(base(&f.ctx, "parent".into()).await.is_err());
        }
        assert_eq!(f.rows("SELECT child_id FROM code_children").await.len(), 0);
        assert_eq!(f.rows("SELECT id FROM runs").await.len(), 1);
        f.close().await;
    }
    #[tokio::test]
    async fn unsupported_git_links_retain_failed_worktrees_without_folder_grants_or_execution() {
        let f = Fixture::new().await;
        let blob = f.git(&["rev-parse", "HEAD:notes.txt"]);
        f.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("120000,{blob},link.txt"),
        ]);
        f.git(&["commit", "-m", "Recorded unsupported link"]);
        let children = prepare(&f.ctx, f.request().await).await.unwrap();
        assert!(children.iter().all(|c| c.state == "failed"));
        assert_eq!(f.rows("SELECT id FROM folders").await.len(), 1);
        assert_eq!(f.rows("SELECT id FROM request_log").await.len(), 0);
        for row in f.rows("SELECT path FROM code_children").await {
            assert!(
                Path::new(row["path"].as_str().unwrap())
                    .join(".git")
                    .exists()
            );
        }
        assert_eq!(
            f.rows("SELECT id FROM runs WHERE status='error'")
                .await
                .len(),
            2
        );
        f.close().await;
    }

    #[tokio::test]
    async fn child_file_authority_ends_with_parent_stop_and_git_is_never_exposed() {
        let f = Fixture::new().await;
        let children = prepare(&f.ctx, f.request().await).await.unwrap();
        let rows = f
            .rows("SELECT child_id,folder_id FROM code_children ORDER BY ordinal")
            .await;
        let folder = rows[0]["folder_id"].as_str().unwrap();
        let pool = f.ctx.db.pool().unwrap();
        assert!(repo::folder_root(&pool, folder).await.is_err());
        db::execute(
            &pool,
            "UPDATE code_children SET state='running' WHERE child_id=?",
            &[json!(children[0].id)],
        )
        .await
        .unwrap();
        db::execute(
            &pool,
            "UPDATE runs SET status='running' WHERE id=?",
            &[json!(children[0].id)],
        )
        .await
        .unwrap();
        assert!(repo::folder_root(&pool, folder).await.is_ok());
        assert!(
            crate::git::repo_git(&f.ctx, folder.into(), "git".into(), vec!["status".into()])
                .await
                .unwrap_err()
                .contains("reviewed")
        );
        db::execute(
            &pool,
            "UPDATE runs SET status='stopped' WHERE id='parent'",
            &[],
        )
        .await
        .unwrap();
        assert!(repo::folder_root(&pool, folder).await.is_err());
        assert_eq!(
            f.rows("SELECT status FROM runs WHERE parent_run_id='parent' AND status='running'")
                .await
                .len(),
            0
        );
        f.close().await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn isolated_commands_have_only_their_worktree_public_tools_and_private_tmp() {
        let f = Fixture::new().await;
        let children = prepare(&f.ctx, f.request().await).await.unwrap();
        let rows = f
            .rows("SELECT path FROM code_children ORDER BY ordinal")
            .await;
        let path = PathBuf::from(rows[0]["path"].as_str().unwrap());
        std::fs::write(f.dir.join("private.txt"), "synthetic host sentinel").unwrap();
        let command = format!(
            "cat notes.txt; test ! -r '{}' && printf 'NO_HOST\\n'; test ! -r '{}' && printf 'NO_PARENT\\n'; test ! -s .git && printf 'NO_GIT\\n'; test \"${{FUSE_CHILD_PROBE-unset}}\" = unset && printf 'NO_INHERIT\\n'; printf child > result.txt; printf overwrite > .git 2>/dev/null || printf 'READ_ONLY_GIT\\n'",
            f.dir.join("private.txt").display(),
            f.root.join("notes.txt").display()
        );
        let sb = crate::exec::Sandbox {
            writable: vec![path.clone()],
            network: false,
            isolated: true,
        };
        let (_sender, receiver) = tokio::sync::oneshot::channel();
        let mut output = String::new();
        let mut done = None;
        crate::exec::run(
            &path,
            &command,
            Duration::from_secs(10),
            receiver,
            Some(&sb),
            |message| match message {
                crate::exec::ExecMsg::Out { text } => output.push_str(&text),
                crate::exec::ExecMsg::Done { exit_code, .. } => done = Some(exit_code),
                crate::exec::ExecMsg::Error { message } => panic!("{message}"),
                _ => {}
            },
        )
        .await;
        assert_eq!(done, Some(Some(0)), "{output}");
        for text in [
            "committed base",
            "NO_HOST",
            "NO_PARENT",
            "NO_GIT",
            "NO_INHERIT",
            "READ_ONLY_GIT",
        ] {
            assert!(output.contains(text), "Missing {text}: {output}");
        }
        assert_eq!(
            std::fs::read_to_string(path.join("result.txt")).unwrap(),
            "child"
        );
        assert_eq!(
            std::fs::read_to_string(f.dir.join("private.txt")).unwrap(),
            "synthetic host sentinel"
        );
        assert_eq!(
            std::fs::read_to_string(f.root.join("notes.txt")).unwrap(),
            "committed base\n"
        );
        assert_eq!(children.len(), 2);
        f.close().await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn native_command_guard_stops_on_parent_control_and_worktree_growth() {
        struct Events(std::sync::Mutex<Vec<crate::exec::ExecMsg>>);
        impl crate::ctx::EventSink<crate::exec::ExecMsg> for Events {
            fn send(&self, m: crate::exec::ExecMsg) -> Result<(), String> {
                self.0.lock().unwrap().push(m);
                Ok(())
            }
        }
        let f = Fixture::new().await;
        prepare(&f.ctx, f.request().await).await.unwrap();
        let pool = f.ctx.db.pool().unwrap();
        let rows = f
            .rows("SELECT child_id,folder_id,path FROM code_children ORDER BY ordinal")
            .await;
        for (i, row) in rows.iter().enumerate() {
            db::execute(
                &pool,
                "UPDATE code_children SET state='running' WHERE child_id=?",
                &[row["child_id"].clone()],
            )
            .await
            .unwrap();
            db::execute(
                &pool,
                "UPDATE runs SET status='running' WHERE id IN('parent',?)",
                &[row["child_id"].clone()],
            )
            .await
            .unwrap();
            if i == 1 {
                std::fs::File::create(
                    Path::new(row["path"].as_str().unwrap()).join("oversize.bin"),
                )
                .unwrap()
                .set_len(513 * 1024 * 1024)
                .unwrap();
            }
            let events = std::sync::Arc::new(Events(std::sync::Mutex::new(Vec::new())));
            let sb: crate::exec::SandboxIn =
                serde_json::from_value(json!({"folderIds":[row["folder_id"]],"network":false}))
                    .unwrap();
            crate::exec::repo_exec(
                &f.ctx,
                row["folder_id"].as_str().unwrap().into(),
                "printf STARTED; sleep 10".into(),
                Some(15),
                Some(sb),
                events.clone(),
            )
            .await
            .unwrap();
            for _ in 0..200 {
                if events.0.lock().unwrap().iter().any(
                    |m| matches!(m,crate::exec::ExecMsg::Out{text} if text.contains("STARTED")),
                ) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(
                events.0.lock().unwrap().iter().any(
                    |m| matches!(m,crate::exec::ExecMsg::Out{text} if text.contains("STARTED"))
                )
            );
            if i == 0 {
                db::execute(
                    &pool,
                    "UPDATE runs SET status='stopped' WHERE id='parent'",
                    &[],
                )
                .await
                .unwrap();
            }
            for _ in 0..300 {
                if events
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|m| matches!(m, crate::exec::ExecMsg::Done { stopped: true, .. }))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(
                events
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|m| matches!(m, crate::exec::ExecMsg::Done { stopped: true, .. })),
                "{:?}",
                events.0.lock().unwrap()
            );
            if i == 1 {
                assert!(events.0.lock().unwrap().iter().any(
                    |m| matches!(m,crate::exec::ExecMsg::Out{text} if text.contains("512 MiB"))
                ));
            }
        }
        for _ in 0..100 {
            if f.ctx.execs.child_running.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(f.ctx.execs.child_running.lock().unwrap().is_empty());
        assert!(f.ctx.execs.running.lock().unwrap().is_empty());
        f.close().await;
    }

    #[tokio::test]
    async fn global_deletion_removes_only_app_owned_worktrees_and_retains_parent_repository() {
        let f = Fixture::new().await;
        prepare(&f.ctx, f.request().await).await.unwrap();
        let paths = f.rows("SELECT path FROM code_children").await;
        std::fs::write(f.ctx.data_dir.join("keep.txt"), "unrelated fixture file").unwrap();
        #[cfg(unix)]
        {
            let link = f.ctx.data_dir.join("code-worktrees").join(id().unwrap());
            std::os::unix::fs::symlink(&f.root, &link).unwrap();
        }
        crate::files::file_wipe(&f.ctx).unwrap();
        for row in paths {
            assert!(!Path::new(row["path"].as_str().unwrap()).exists());
        }
        assert_eq!(
            std::fs::read_to_string(f.root.join("notes.txt")).unwrap(),
            "committed base\n"
        );
        assert_eq!(
            std::fs::read_to_string(f.ctx.data_dir.join("keep.txt")).unwrap(),
            "unrelated fixture file"
        );
        f.close().await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn private_child_commands_share_no_parent_or_sibling_grants_and_revoke_after_exit() {
        let f = Fixture::new().await;
        prepare(&f.ctx, f.request().await).await.unwrap();
        let rows = f
            .rows("SELECT path FROM code_children ORDER BY ordinal")
            .await;
        let a = fuse_sandbox_win::plain(Path::new(rows[0]["path"].as_str().unwrap()));
        let b = fuse_sandbox_win::plain(Path::new(rows[1]["path"].as_str().unwrap()));
        let parent = fuse_sandbox_win::plain(&f.root);
        assert!(
            fuse_sandbox_win::grant_to(
                fuse_sandbox_win::Container::Commands,
                &parent,
                fuse_sandbox_win::WRITE
            )
            .unwrap()
        );
        let source = r#"fn main(){
          let args:Vec<_>=std::env::args_os().collect();
          assert!(std::fs::read(&args[1]).is_err(),"parent grant escaped");
          assert!(std::fs::read(&args[2]).is_err(),"sibling grant escaped");
          assert_eq!(std::fs::read_to_string("notes.txt").unwrap(),"committed base\n");
          std::fs::write("made.txt","private child").unwrap();
          for (name,_) in std::env::vars_os(){assert!(["systemroot","userprofile","appdata","localappdata","path","pathext","temp","tmp"].contains(&name.to_string_lossy().to_lowercase().as_str()),"unapproved environment name");}
          let cmd=std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32").join("cmd.exe");
          assert!(std::process::Command::new(cmd).args(["/C","exit","0"]).status().unwrap().success());
          println!("ISOLATED_CHILD");
        }"#;
        std::fs::write(a.join("probe.rs"), source).unwrap();
        let compiled = std::process::Command::new("rustc")
            .args(["--edition=2024"])
            .arg(a.join("probe.rs"))
            .arg("-o")
            .arg(a.join("probe.exe"))
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "native fixture compilation failed"
        );
        std::fs::copy(a.join("probe.exe"), b.join("probe.exe")).unwrap();
        let ca = format!(
            "\"{}\" \"{}\" \"{}\"",
            a.join("probe.exe").display(),
            parent.join("notes.txt").display(),
            b.join("notes.txt").display()
        );
        let cb = format!(
            "\"{}\" \"{}\" \"{}\"",
            b.join("probe.exe").display(),
            parent.join("notes.txt").display(),
            a.join("notes.txt").display()
        );
        let sa = crate::exec::Sandbox {
            writable: vec![a.clone()],
            network: false,
            isolated: true,
        };
        let sb = crate::exec::Sandbox {
            writable: vec![b.clone()],
            network: false,
            isolated: true,
        };
        let (_ta, ra) = tokio::sync::oneshot::channel();
        let (_tb, rb) = tokio::sync::oneshot::channel();
        let (mut oa, mut ob) = (String::new(), String::new());
        let (mut da, mut db) = (None, None);
        tokio::join!(
            crate::exec::run(
                &a,
                &ca,
                Duration::from_secs(10),
                ra,
                Some(&sa),
                |m| match m {
                    crate::exec::ExecMsg::Out { text } => oa.push_str(&text),
                    crate::exec::ExecMsg::Done { exit_code, .. } => da = Some(exit_code),
                    crate::exec::ExecMsg::Error { message } => panic!("{message}"),
                    _ => {}
                }
            ),
            crate::exec::run(
                &b,
                &cb,
                Duration::from_secs(10),
                rb,
                Some(&sb),
                |m| match m {
                    crate::exec::ExecMsg::Out { text } => ob.push_str(&text),
                    crate::exec::ExecMsg::Done { exit_code, .. } => db = Some(exit_code),
                    crate::exec::ExecMsg::Error { message } => panic!("{message}"),
                    _ => {}
                }
            )
        );
        assert_eq!(da, Some(Some(0)), "{oa}");
        assert_eq!(db, Some(Some(0)), "{ob}");
        assert!(oa.contains("ISOLATED_CHILD") && ob.contains("ISOLATED_CHILD"));
        assert_eq!(
            std::fs::read_to_string(a.join("made.txt")).unwrap(),
            "private child"
        );
        assert_eq!(
            std::fs::read_to_string(b.join("made.txt")).unwrap(),
            "private child"
        );
        assert_eq!(
            std::fs::read_dir(a.parent().unwrap().join(".command-grants"))
                .unwrap()
                .count(),
            0
        );
        fuse_sandbox_win::revoke_from(fuse_sandbox_win::Container::Commands, &parent).unwrap();
        f.close().await;
    }
}
