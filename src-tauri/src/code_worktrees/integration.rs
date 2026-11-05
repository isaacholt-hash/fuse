//! Explicit review tokens; commits use raw Git objects and integration gets a fresh worktree.
//! No operation checks out, merges into, or changes the original working folder/index.
use super::*;
use std::collections::BTreeMap;
use std::io::Read;

const REVIEW_FILE: usize = 256 * 1024;
const REVIEW_TOTAL: usize = 1024 * 1024;
const REVIEW_FILES: usize = 100;
static MUTATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileDiff {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub mode: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitPin {
    pub child_id: String,
    pub commit: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub id: String,
    pub parent_id: String,
    pub child_id: Option<String>,
    pub parent_base: Base,
    pub index_hash: String,
    pub child_head: Option<String>,
    pub files: Vec<FileDiff>,
    pub commits: Vec<CommitPin>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultInfo {
    pub commit: String,
    pub branch: String,
    pub path: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub child_id: Option<String>,
    pub result: Option<ResultInfo>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    mode: String,
    oid: String,
}
type Tree = BTreeMap<String, Entry>;

fn field(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<String, String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("Missing retained review {key}."))
}
fn oid(bytes: Vec<u8>) -> Result<String, String> {
    let text = String::from_utf8(bytes).map_err(|_| "Invalid Git object identity.")?;
    let value = text.trim();
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid Git object identity.".into());
    }
    Ok(value.into())
}
fn bounded_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    if linklike(path) {
        return Err("Review refuses linked files and Git metadata.".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options
        .open(path)
        .map_err(|_| "A reviewed file or Git pointer is unavailable.")?;
    let meta = file
        .metadata()
        .map_err(|_| "Couldn't verify a reviewed file.")?;
    if !meta.is_file() || meta.len() > limit as u64 {
        return Err("Review requires bounded regular files.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err("Review refuses hard-linked files.".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0
            || !fuse_sandbox_win::single_link_file(&file)
                .map_err(|_| "Could not verify Windows file links.")?
        {
            return Err("Review refuses reparse points and hard-linked files.".into());
        }
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Couldn't read the reviewed file.")?;
    if bytes.len() > limit {
        return Err("Review file exceeded its bound.".into());
    }
    Ok(bytes)
}
/// Do not discover an ancestor repository outside the selected folder. A linked worktree's
/// .git file must be reciprocally bound to this root, rather than aliasing another checkout.
pub(super) fn validate_parent_git_root(root: &Path) -> Result<(), String> {
    let pointer = root.join(".git");
    if linklike(&pointer) {
        return Err("Choose an explicit repository root without linked Git pointers.".into());
    }
    if pointer.is_dir() {
        return Ok(());
    }
    if !pointer.is_file() {
        return Err("Parallel Code requires the selected repository root, not a subfolder or bare object store.".into());
    }
    let value = text(bounded_file(&pointer, 8192)?)?;
    let target = value
        .trim()
        .strip_prefix("gitdir: ")
        .ok_or("The repository root has an invalid Git pointer.")?;
    let git_dir = std::fs::canonicalize(root.join(target))
        .map_err(|_| "The repository's Git administration is missing.")?;
    if linklike(&git_dir) {
        return Err("The repository's Git administration is linked.".into());
    }
    let back = text(bounded_file(&git_dir.join("gitdir"), 8192)?)?;
    let back = std::fs::canonicalize(git_dir.join(back.trim()))
        .map_err(|_| "This Git pointer does not identify a recorded worktree root.")?;
    if back != std::fs::canonicalize(pointer).map_err(|_| "The repository root pointer changed.")? {
        return Err("This Git pointer belongs to a different repository worktree root.".into());
    }
    Ok(())
}

fn text(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.contains(&0) {
        return Err(
            "Parallel review supports UTF-8 text; retain binary changes for manual review.".into(),
        );
    }
    String::from_utf8(bytes).map_err(|_| "Parallel review requires UTF-8 text.".into())
}
fn no_links(root: &Path, path: &str) -> Result<PathBuf, String> {
    if !safe_path(path) {
        return Err("Review requires portable relative paths.".into());
    }
    let mut at = root.to_path_buf();
    for part in path.split('/') {
        at.push(part);
        if linklike(&at) {
            return Err("Review refuses linked path components.".into());
        }
    }
    Ok(at)
}
async fn tree(root: &Path, revision: &str) -> Result<Tree, String> {
    let bytes = git(root, &["ls-tree", "-r", "-z", revision], 2 * 1024 * 1024).await?;
    let mut result = Tree::new();
    let mut lower = BTreeSet::new();
    for raw in bytes.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        let (meta, path) = std::str::from_utf8(raw)
            .map_err(|_| "Non-UTF8 Git paths cannot be reviewed.")?
            .split_once('\t')
            .ok_or("Invalid Git tree.")?;
        let parts: Vec<_> = meta.split_whitespace().collect();
        if result.len() >= MAX_FILES
            || parts.len() != 3
            || parts[1] != "blob"
            || !matches!(parts[0], "100644" | "100755")
            || !safe_path(path)
            || !lower.insert(path.to_lowercase())
        {
            return Err(
                "Review refuses links, submodules and nonportable/colliding tree paths.".into(),
            );
        }
        oid(parts[2].as_bytes().to_vec())?;
        result.insert(
            path.into(),
            Entry {
                mode: parts[0].into(),
                oid: parts[2].into(),
            },
        );
    }
    Ok(result)
}
async fn parent_pin(ctx: &Ctx, parent_id: &str) -> Result<(PathBuf, Base, String), String> {
    let (_, root, folder) = parent_scope(ctx, parent_id, false).await?;
    let pool = ctx.db.pool()?;
    let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM code_children WHERE workspace_id=? AND user_id=? AND parent_id=? AND state IN('creating','ready','running')")
        .bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(parent_id).fetch_one(&pool).await.map_err(fail)?;
    if active != 0 {
        return Err("Stop or finish all child work before reviewing commits.".into());
    }
    let base = read_base(&root, folder).await?;
    let index = hash(&git(&root, &["ls-files", "--stage", "-z"], 2 * 1024 * 1024).await?);
    Ok((root, base, index))
}
async fn child_root(
    ctx: &Ctx,
    parent_id: &str,
    child_id: &str,
    parent_root: &Path,
    base: &Base,
) -> Result<(PathBuf, String), String> {
    let pool = ctx.db.pool()?;
    let rows = db::select(&pool, "SELECT c.* FROM code_children c JOIN runs r ON r.id=c.child_id AND r.workspace_id=c.workspace_id AND r.user_id=c.user_id JOIN runs p ON p.id=c.parent_id AND p.workspace_id=c.workspace_id AND p.user_id=c.user_id JOIN folders f ON f.id=c.folder_id AND f.workspace_id=c.workspace_id AND f.user_id=c.user_id AND f.path=c.path JOIN run_folders rf ON rf.run_id=c.child_id AND rf.folder_id=c.folder_id AND rf.workspace_id=c.workspace_id WHERE r.project_id IS p.project_id AND r.thread_id IS p.thread_id AND r.kind='code' AND r.mode!='plan' AND r.review_profile=0 AND c.workspace_id=? AND c.user_id=? AND c.parent_id=? AND c.child_id=? AND c.state IN('complete','interrupted','failed') AND r.status!='running' AND r.parent_run_id=c.parent_id AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id))", &[json!(crate::sync::WORKSPACE),json!(crate::sync::USER),json!(parent_id),json!(child_id)]).await?;
    let row = rows
        .first()
        .ok_or("This owner has no finished worktree for that child.")?;
    let request: Request = serde_json::from_str(&field(row, "request")?)
        .map_err(|_| "Retained child authority is malformed.")?;
    if request.base != *base {
        return Err(
            "The parent changed since delegation. Review retained branches before integrating."
                .into(),
        );
    }
    let owner_dir = ctx.data_dir.join("code-worktrees");
    if linklike(&owner_dir) {
        return Err("The worktree store is linked.".into());
    }
    let owner_dir =
        std::fs::canonicalize(owner_dir).map_err(|_| "The worktree store is unavailable.")?;
    #[cfg(windows)]
    let owner_dir = git_path(owner_dir)?;
    let expected = owner_dir.join(child_id);
    let recorded_path = field(row, "path")?;
    if linklike(&expected) || Path::new(&recorded_path) != expected {
        return Err("The recorded child worktree changed location.".into());
    }
    let root =
        std::fs::canonicalize(&expected).map_err(|_| "The retained worktree is unavailable.")?;
    #[cfg(windows)]
    let root = git_path(root)?;
    let pointer = bounded_file(&root.join(".git"), 8192)?;
    if hash(&pointer) != field(row, "git_pointer_sha256")? {
        return Err("The child Git pointer changed. No Git operation was performed there.".into());
    }
    let dir = PathBuf::from(field(row, "git_dir")?);
    if linklike(&dir) || !dir.is_dir() {
        return Err("Child Git administration is no longer trusted.".into());
    }
    for file in ["HEAD", "index", "commondir", "gitdir", "config.worktree"] {
        if linklike(&dir.join(file)) {
            return Err("Linked child Git administration is refused.".into());
        }
    }
    let common = text(bounded_file(&dir.join("commondir"), 8192)?)?;
    let actual_common = std::fs::canonicalize(dir.join(common.trim()))
        .map_err(|_| "Child Git common directory is missing.")?;
    let parent_common = text(
        git(
            parent_root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            8192,
        )
        .await?,
    )?;
    if actual_common
        != std::fs::canonicalize(parent_common.trim())
            .map_err(|_| "Parent Git administration is missing.")?
    {
        return Err("The child points at another repository.".into());
    }
    let branch = format!("refs/heads/fuse/child/{child_id}");
    if text(bounded_file(&dir.join("HEAD"), 1024)?)?.trim() != format!("ref: {branch}") {
        return Err("The child branch identity changed.".into());
    }
    let head = oid(git(&root, &["rev-parse", "--verify", "HEAD^{commit}"], 128).await?)?;
    if head != base.commit {
        let known: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM code_child_reviews WHERE workspace_id=? AND user_id=? AND parent_id=? AND child_id=? AND kind='child' AND state IN('committed','failed') AND json_extract(result,'$.commit')=?")
            .bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(parent_id).bind(child_id).bind(&head).fetch_one(&pool).await.map_err(fail)?;
        if known == 0 {
            return Err("The child revision changed outside the reviewed commit controls.".into());
        }
    }
    Ok((root, head))
}
async fn blob(root: &Path, entry: Option<&Entry>) -> Result<Option<String>, String> {
    match entry {
        None => Ok(None),
        Some(e) => text(git(root, &["cat-file", "blob", &e.oid], REVIEW_FILE).await?).map(Some),
    }
}
fn bounded(diffs: &[FileDiff]) -> Result<(), String> {
    if diffs.len() > REVIEW_FILES
        || diffs
            .iter()
            .map(|f| {
                f.before.as_ref().map_or(0, String::len) + f.after.as_ref().map_or(0, String::len)
            })
            .sum::<usize>()
            > REVIEW_TOTAL
    {
        return Err("Review supports at most 100 text files and 1 MiB of diffs. Keep larger changes for manual review.".into());
    }
    Ok(())
}
async fn child_snapshot(
    ctx: &Ctx,
    parent_id: &str,
    child_id: &str,
    token: String,
) -> Result<Snapshot, String> {
    let (parent, base, index) = parent_pin(ctx, parent_id).await?;
    let (root, head) = child_root(ctx, parent_id, child_id, &parent, &base).await?;
    let before = tree(&root, &head).await?;
    let listing = git(
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
    let mut paths = BTreeSet::new();
    for raw in listing.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        paths.insert(
            std::str::from_utf8(raw)
                .map_err(|_| "Non-UTF8 child path.")?
                .to_string(),
        );
        if paths.len() > MAX_FILES {
            return Err("Too many child files to review.".into());
        }
    }
    paths.extend(before.keys().cloned());
    if paths.len() > MAX_FILES {
        return Err("Too many child paths to review.".into());
    }
    let mut scanned = 0usize;
    let mut files = Vec::new();
    for path in paths {
        let target = no_links(&root, &path)?;
        if path.split('/').any(repo::is_secret) {
            if target.exists() {
                return Err("A secret-looking file exists in the child. Remove it from this review before committing.".into());
            }
            continue;
        }
        let previous = before.get(&path);
        let after_bytes = if target.exists() {
            Some(bounded_file(&target, FILE_BYTES)?)
        } else {
            None
        };
        let old_bytes = match previous {
            Some(e) => Some(git(&root, &["cat-file", "blob", &e.oid], FILE_BYTES).await?),
            None => None,
        };
        scanned = scanned
            .saturating_add(old_bytes.as_ref().map_or(0, Vec::len))
            .saturating_add(after_bytes.as_ref().map_or(0, Vec::len));
        if scanned > 2 * TOTAL_BYTES {
            return Err("Child review exceeded its 256 MiB scan limit.".into());
        }
        let mode = previous.map_or("100644", |e| e.mode.as_str()).to_string();
        #[cfg(unix)]
        let mode = if after_bytes.is_some() {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&target)
                .map_err(|_| "A reviewed file changed.")?
                .permissions()
                .mode()
                & 0o111
                != 0
            {
                "100755"
            } else {
                "100644"
            }
            .to_string()
        } else {
            mode
        };
        // Raw byte comparison ignores filters, attributes and external diff programs.
        if old_bytes != after_bytes || previous.is_some_and(|e| e.mode != mode) {
            if old_bytes.as_ref().is_some_and(|b| b.len() > REVIEW_FILE)
                || after_bytes.as_ref().is_some_and(|b| b.len() > REVIEW_FILE)
            {
                return Err("A changed file exceeds the 256 KiB review limit.".into());
            }
            let old = old_bytes.map(text).transpose()?;
            let after = after_bytes.map(text).transpose()?;
            files.push(FileDiff {
                path,
                before: old,
                after,
                mode,
            });
            bounded(&files)?;
        }
    }
    Ok(Snapshot {
        id: token,
        parent_id: parent_id.into(),
        child_id: Some(child_id.into()),
        parent_base: base,
        index_hash: index,
        child_head: Some(head),
        files,
        commits: Vec::new(),
    })
}
fn merge_trees(base: &Tree, trees: &[Tree]) -> Result<Tree, String> {
    let mut merged = base.clone();
    for child in trees {
        for path in base.keys().chain(child.keys()).collect::<BTreeSet<_>>() {
            let original = base.get(path);
            let incoming = child.get(path);
            if incoming == original {
                continue;
            }
            if path.split('/').any(repo::is_secret) {
                return Err(
                    "A child commit changes a secret-looking path. Integration is paused.".into(),
                );
            }
            let current = merged.get(path);
            if current != original && current != incoming {
                return Err(format!(
                    "Children have conflicting edits in {path}. Their commits and worktrees are retained; resolve explicitly before integration."
                ));
            }
            match incoming {
                Some(e) => {
                    merged.insert(path.clone(), e.clone());
                }
                None => {
                    merged.remove(path);
                }
            }
        }
    }
    let lower: BTreeSet<_> = merged.keys().map(|p| p.to_lowercase()).collect();
    if lower.len() != merged.len() {
        return Err("Integrated paths collide on case-insensitive filesystems.".into());
    }
    for path in &lower {
        let parts: Vec<_> = path.split('/').collect();
        for end in 1..parts.len() {
            if lower.contains(&parts[..end].join("/")) {
                return Err("Integrated file and directory paths conflict.".into());
            }
        }
    }
    Ok(merged)
}
async fn integration_snapshot(
    ctx: &Ctx,
    parent_id: &str,
    commits: Vec<CommitPin>,
    token: String,
) -> Result<Snapshot, String> {
    if commits.is_empty()
        || commits.len() > 3
        || commits
            .iter()
            .map(|c| &c.child_id)
            .collect::<BTreeSet<_>>()
            .len()
            != commits.len()
    {
        return Err("Choose one to three distinct reviewed child commits.".into());
    }
    let (root, base, index) = parent_pin(ctx, parent_id).await?;
    let original = tree(&root, &base.commit).await?;
    let mut trees = Vec::new();
    for pin in &commits {
        oid(pin.commit.as_bytes().to_vec())?;
        let child = child_snapshot(ctx, parent_id, &pin.child_id, String::new()).await?;
        if child.child_head.as_ref() != Some(&pin.commit) || !child.files.is_empty() {
            return Err("A selected child changed after its commit. Review and commit its current changes first.".into());
        }
        // An original base is not an approved child commit.
        let known:i64=sqlx::query_scalar("SELECT COUNT(*) FROM code_child_reviews WHERE workspace_id=? AND user_id=? AND parent_id=? AND child_id=? AND kind='child' AND state IN('committed','failed') AND json_extract(result,'$.commit')=?")
            .bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(parent_id).bind(&pin.child_id).bind(&pin.commit).fetch_one(&ctx.db.pool()?).await.map_err(fail)?;
        if known == 0 {
            return Err("Commit the reviewed child changes before preparing integration.".into());
        }
        trees.push(tree(&root, &pin.commit).await?);
    }
    let merged = merge_trees(&original, &trees)?;
    let mut files = Vec::new();
    for path in original
        .keys()
        .chain(merged.keys())
        .collect::<BTreeSet<_>>()
    {
        if original.get(path) != merged.get(path) {
            files.push(FileDiff {
                path: path.clone(),
                before: blob(&root, original.get(path)).await?,
                after: blob(&root, merged.get(path)).await?,
                mode: merged
                    .get(path)
                    .or_else(|| original.get(path))
                    .ok_or("Missing reviewed path.")?
                    .mode
                    .clone(),
            });
            bounded(&files)?;
        }
    }
    Ok(Snapshot {
        id: token,
        parent_id: parent_id.into(),
        child_id: None,
        parent_base: base,
        index_hash: index,
        child_head: None,
        files,
        commits,
    })
}
async fn record(ctx: &Ctx, snapshot: Snapshot) -> Result<Snapshot, String> {
    if snapshot.files.is_empty() {
        return Err("There are no new text changes to commit or integrate.".into());
    }
    sqlx::query("INSERT INTO code_child_reviews(id,workspace_id,user_id,parent_id,child_id,kind,snapshot,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'review',?,?)")
        .bind(&snapshot.id).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(&snapshot.parent_id).bind(&snapshot.child_id).bind(if snapshot.child_id.is_some(){"child"}else{"integration"}).bind(serde_json::to_string(&snapshot).map_err(|_|"Invalid review snapshot.")?).bind(now()).bind(now()).execute(&ctx.db.pool()?).await.map_err(fail)?;
    Ok(snapshot)
}
pub async fn review(ctx: &Ctx, parent_id: String, child_id: String) -> Result<Snapshot, String> {
    let _guard = MUTATIONS.lock().await;
    let snapshot = tokio::time::timeout(
        Duration::from_secs(60),
        child_snapshot(ctx, &parent_id, &child_id, id()?),
    )
    .await
    .map_err(|_| "Child review exceeded one minute. Its worktree is retained.")??;
    record(ctx, snapshot).await
}
pub async fn plan(
    ctx: &Ctx,
    parent_id: String,
    commits: Vec<CommitPin>,
) -> Result<Snapshot, String> {
    let _guard = MUTATIONS.lock().await;
    let snapshot = tokio::time::timeout(
        Duration::from_secs(60),
        integration_snapshot(ctx, &parent_id, commits, id()?),
    )
    .await
    .map_err(|_| "Integration review exceeded one minute. Its commits are retained.")??;
    record(ctx, snapshot).await
}
pub async fn attempts(ctx: &Ctx, parent_id: String) -> Result<Vec<Attempt>, String> {
    parent_pin(ctx, &parent_id).await?;
    let rows=db::select(&ctx.db.pool()?,"SELECT id,child_id,kind,state,result FROM code_child_reviews WHERE workspace_id=? AND user_id=? AND parent_id=? ORDER BY created_at DESC,id DESC LIMIT 100",&[json!(crate::sync::WORKSPACE),json!(crate::sync::USER),json!(parent_id)]).await?;
    rows.into_iter()
        .map(|row| {
            Ok(Attempt {
                id: field(&row, "id")?,
                kind: field(&row, "kind")?,
                state: field(&row, "state")?,
                child_id: row["child_id"].as_str().map(String::from),
                result: row["result"]
                    .as_str()
                    .map(serde_json::from_str)
                    .transpose()
                    .map_err(|_| "Malformed retained integration result.")?,
            })
        })
        .collect()
}
/// Explicitly release a lost attempt's claim. Keep every branch/worktree/object as evidence.
pub async fn discard(ctx: &Ctx, parent_id: String, token: String) -> Result<(), String> {
    let _guard = MUTATIONS.lock().await;
    parent_pin(ctx, &parent_id).await?;
    sqlx::query("UPDATE code_child_reviews SET state='failed',updated_at=? WHERE workspace_id=? AND user_id=? AND parent_id=? AND id=? AND state IN('review','working')")
        .bind(now()).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(parent_id).bind(token).execute(&ctx.db.pool()?).await.map_err(fail)?;
    Ok(())
}
async fn make_tree(root: &Path, entries: &Tree) -> Result<String, String> {
    // Bottom-up trees use only raw object IDs. No index, attributes, checkout or hooks.
    let mut dirs: BTreeMap<String, Vec<(String, String, String)>> = BTreeMap::new();
    dirs.insert(String::new(), Vec::new());
    for (path, entry) in entries {
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
        dirs.entry(dir.into()).or_default().push((
            entry.mode.clone(),
            entry.oid.clone(),
            name.into(),
        ));
        let mut next = dir;
        while !next.is_empty() {
            let (parent, _) = next.rsplit_once('/').unwrap_or(("", next));
            dirs.entry(parent.into()).or_default();
            next = parent;
        }
    }
    let mut order: Vec<_> = dirs.keys().cloned().collect();
    order.sort_by_key(|p| std::cmp::Reverse(p.split('/').count()));
    // Root has depth zero, distinct from one-component folders.
    order.retain(|p| !p.is_empty());
    order.push(String::new());
    let mut root_oid = None;
    for dir in order {
        let mut input = Vec::new();
        for (mode, oid, name) in dirs.get(&dir).ok_or("Missing reviewed tree directory.")? {
            let kind = if mode == "040000" { "tree" } else { "blob" };
            input.extend_from_slice(format!("{mode} {kind} {oid}\t{name}\0").as_bytes());
        }
        let made = oid(git_io(root, &["mktree", "-z"], 128, Some(&input)).await?)?;
        if dir.is_empty() {
            root_oid = Some(made);
        } else {
            let (parent, name) = dir.rsplit_once('/').unwrap_or(("", dir.as_str()));
            dirs.get_mut(parent).ok_or("Missing parent tree.")?.push((
                "040000".into(),
                made,
                name.into(),
            ));
        }
    }
    root_oid.ok_or_else(|| "No reviewed tree was produced.".into())
}
async fn commit_object(
    root: &Path,
    tree: &str,
    parents: &[String],
    message: &str,
) -> Result<String, String> {
    let mut args = vec!["commit-tree", "--no-gpg-sign", tree];
    for parent in parents {
        args.extend(["-p", parent.as_str()]);
    }
    args.extend(["-m", message]);
    oid(git(root, &args, 128).await?)
}
async fn persist_result(ctx: &Ctx, token: &str, result: &ResultInfo) -> Result<(), String> {
    let updated=sqlx::query("UPDATE code_child_reviews SET result=?,updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND state='working'")
        .bind(serde_json::to_string(result).map_err(|_|"Invalid retained result.")?).bind(now()).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(token).execute(&ctx.db.pool()?).await.map_err(fail)?;
    if updated.rows_affected() != 1 {
        return Err(
            "The review was deleted or cancelled. Its objects are retained without integration."
                .into(),
        );
    }
    Ok(())
}
async fn fresh(ctx: &Ctx, snapshot: &Snapshot) -> Result<(), String> {
    let actual = if let Some(child) = &snapshot.child_id {
        child_snapshot(ctx, &snapshot.parent_id, child, snapshot.id.clone()).await?
    } else {
        integration_snapshot(
            ctx,
            &snapshot.parent_id,
            snapshot.commits.clone(),
            snapshot.id.clone(),
        )
        .await?
    };
    if actual != *snapshot {
        return Err("The reviewed parent, child or files changed. Nothing else was integrated; review the retained work again.".into());
    }
    Ok(())
}
pub async fn apply(ctx: &Ctx, token: String) -> Result<ResultInfo, String> {
    // The owner keeps its mutation/lock alive if an HTTP caller or webview disappears.
    // Dropping a response waiter must not let wipe race a still-stopping Git subprocess.
    let owner = ctx.sync_view()?;
    tokio::spawn(async move { apply_owned(&owner, token).await })
        .await
        .map_err(|_| "The repository operation was interrupted. Inspect the retained owner claim before another action.".to_string())?
}

async fn apply_owned(ctx: &Ctx, token: String) -> Result<ResultInfo, String> {
    let _guard = MUTATIONS.lock().await;
    let pool = ctx.db.pool()?;
    let rows = db::select(
        &pool,
        "SELECT * FROM code_child_reviews WHERE workspace_id=? AND user_id=? AND id=?",
        &[
            json!(crate::sync::WORKSPACE),
            json!(crate::sync::USER),
            json!(token),
        ],
    )
    .await?;
    let row = rows
        .first()
        .ok_or("This owner has no such reviewed operation.")?;
    let snapshot: Snapshot = serde_json::from_str(&field(row, "snapshot")?)
        .map_err(|_| "Retained review is malformed.")?;
    parent_pin(ctx, &snapshot.parent_id).await?;
    let state = field(row, "state")?;
    if matches!(state.as_str(), "committed" | "complete") {
        return serde_json::from_str(&field(row, "result")?)
            .map_err(|_| "Retained result is malformed.".into());
    }
    if state != "review" {
        return Err("This review was already attempted or cancelled. Inspect its retained evidence; release an interrupted claim explicitly before a fresh review.".into());
    }
    let created = row["created_at"].as_i64().ok_or("Missing review time.")?;
    if now().saturating_sub(created) > 30 * 60 * 1000 {
        return Err("This review expired. Review the current changes before approving.".into());
    }
    tokio::time::timeout(Duration::from_secs(60), fresh(ctx, &snapshot))
        .await
        .map_err(|_| "Review validation exceeded one minute.")??;
    let claimed=sqlx::query("UPDATE code_child_reviews SET state='working',updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND state='review'")
        .bind(now()).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(&token).execute(&pool).await.map_err(|_|"Another integration attempt is active. Inspect or finish it first.")?;
    if claimed.rows_affected() != 1 {
        return Err("This approval is no longer pending.".into());
    }
    let result=tokio::time::timeout(Duration::from_secs(90),perform(ctx,&snapshot)).await.map_err(|_|"The reviewed operation exceeded its limit. Its branches/worktree and claim are retained; inspect them before another attempt.".to_string()).and_then(|v|v);
    match result {
        Ok(info) => {
            let final_state = if snapshot.child_id.is_some() {
                "committed"
            } else {
                "complete"
            };
            let mut tx = pool.begin().await.map_err(fail)?;
            let changed=sqlx::query("UPDATE code_child_reviews SET state=?,updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND state='working'")
                .bind(final_state).bind(now()).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(&token).execute(&mut *tx).await.map_err(fail)?;
            if changed.rows_affected() != 1 {
                return Err("The history was deleted during the operation. Its repository evidence is retained.".into());
            }
            // Existing redacted tool audit: fixed operation, pinned hashes, no file contents or paths.
            sqlx::query("INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,tool_call_id,tool_name,input,output,is_error,approval,created_at,updated_at) SELECT ?,?,?,?,COALESCE(MAX(seq),-1)+1,'tool',?,?,?, ?,0,'you',?,? FROM run_steps WHERE run_id=?")
                .bind(format!("child-review-{token}")).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(&snapshot.parent_id).bind(&token).bind(if snapshot.child_id.is_some(){"commit_reviewed_child"}else{"integrate_reviewed_children"})
                .bind(json!({"parentRevision":snapshot.parent_base.commit,"childCommits":snapshot.commits,"childId":snapshot.child_id,"childRevision":snapshot.child_head}).to_string())
                .bind(json!({"commit":info.commit,"branch":info.branch,"originalFolderUnchanged":true}).to_string()).bind(now()).bind(now()).bind(&snapshot.parent_id).execute(&mut *tx).await.map_err(fail)?;
            tx.commit().await.map_err(fail)?;
            Ok(info)
        }
        Err(error) => {
            // A failed acknowledgement may follow a successful ref write. Never replay it.
            let _=sqlx::query("UPDATE code_child_reviews SET state='failed',updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND state='working'")
                .bind(now()).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(&token).execute(&pool).await;
            Err(error)
        }
    }
}
async fn perform(ctx: &Ctx, snapshot: &Snapshot) -> Result<ResultInfo, String> {
    let (parent, _, _) = parent_pin(ctx, &snapshot.parent_id).await?;
    if let Some(child) = &snapshot.child_id {
        let (root, head) = child_root(
            ctx,
            &snapshot.parent_id,
            child,
            &parent,
            &snapshot.parent_base,
        )
        .await?;
        let mut entries = tree(&root, &head).await?;
        for file in &snapshot.files {
            if let Some(after) = &file.after {
                let object = oid(git_io(
                    &root,
                    &["hash-object", "-w", "--no-filters", "--stdin"],
                    128,
                    Some(after.as_bytes()),
                )
                .await?)?;
                entries.insert(
                    file.path.clone(),
                    Entry {
                        mode: file.mode.clone(),
                        oid: object,
                    },
                );
            } else {
                entries.remove(&file.path);
            }
        }
        let tree = make_tree(&root, &entries).await?;
        let commit = commit_object(
            &root,
            &tree,
            std::slice::from_ref(&head),
            "FUSE: reviewed child changes",
        )
        .await?;
        let branch = format!("fuse/child/{child}");
        let info = ResultInfo {
            commit: commit.clone(),
            branch: branch.clone(),
            path: root.to_string_lossy().into_owned(),
        };
        persist_result(ctx, &snapshot.id, &info).await?;
        fresh(ctx, snapshot).await?;
        git(
            &root,
            &[
                "update-ref",
                "--no-deref",
                &format!("refs/heads/{branch}"),
                &commit,
                &head,
            ],
            8192,
        )
        .await?;
        git(&root, &["read-tree", &commit], 8192).await?;
        // Secret paths remain absent and protected by the original scope after index refresh.
        for path in entries.keys().filter(|p| p.split('/').any(repo::is_secret)) {
            git(
                &root,
                &["update-index", "--skip-worktree", "--", path],
                8192,
            )
            .await?;
        }
        Ok(info)
    } else {
        let original = tree(&parent, &snapshot.parent_base.commit).await?;
        let mut trees = Vec::new();
        for pin in &snapshot.commits {
            trees.push(tree(&parent, &pin.commit).await?);
        }
        let merged = merge_trees(&original, &trees)?;
        let tree = make_tree(&parent, &merged).await?;
        let mut parents = vec![snapshot.parent_base.commit.clone()];
        parents.extend(snapshot.commits.iter().map(|p| p.commit.clone()));
        let commit = commit_object(
            &parent,
            &tree,
            &parents,
            "FUSE: approved integration of reviewed children",
        )
        .await?;
        let branch = format!("fuse/integration/{}", snapshot.id);
        let store = ctx.data_dir.join("code-worktrees");
        if linklike(&store) {
            return Err("The integration store is linked.".into());
        }
        let store =
            std::fs::canonicalize(store).map_err(|_| "The integration store is missing.")?;
        #[cfg(windows)]
        let store = git_path(store)?;
        let path = store.join(&snapshot.id);
        let path_text = path
            .to_str()
            .ok_or("Integration needs a UTF-8 storage path.")?;
        let info = ResultInfo {
            commit: commit.clone(),
            branch: branch.clone(),
            path: path_text.into(),
        };
        persist_result(ctx, &snapshot.id, &info).await?;
        fresh(ctx, snapshot).await?;
        // -b refuses an existing branch; --no-checkout avoids every checkout/filter hook.
        git(
            &parent,
            &[
                "worktree",
                "add",
                "--no-checkout",
                "-b",
                &branch,
                "--",
                path_text,
                &commit,
            ],
            8192,
        )
        .await?;
        git(&path, &["read-tree", &commit], 8192).await?;
        materialize(&path, &commit).await?;
        fresh(ctx, snapshot).await?;
        Ok(info)
    }
}

pub mod commands {
    use super::*;
    #[tauri::command]
    pub async fn code_child_review(
        ctx: tauri::State<'_, Ctx>,
        parent_id: String,
        child_id: String,
    ) -> Result<Snapshot, String> {
        review(&ctx, parent_id, child_id).await
    }
    #[tauri::command]
    pub async fn code_child_integration_plan(
        ctx: tauri::State<'_, Ctx>,
        parent_id: String,
        commits: Vec<CommitPin>,
    ) -> Result<Snapshot, String> {
        plan(&ctx, parent_id, commits).await
    }
    #[tauri::command]
    pub async fn code_child_apply(
        ctx: tauri::State<'_, Ctx>,
        token: String,
    ) -> Result<ResultInfo, String> {
        apply(&ctx, token).await
    }
    #[tauri::command]
    pub async fn code_child_attempts(
        ctx: tauri::State<'_, Ctx>,
        parent_id: String,
    ) -> Result<Vec<Attempt>, String> {
        attempts(&ctx, parent_id).await
    }
    #[tauri::command]
    pub async fn code_child_discard(
        ctx: tauri::State<'_, Ctx>,
        parent_id: String,
        token: String,
    ) -> Result<(), String> {
        discard(&ctx, parent_id, token).await
    }
}

/// Delete-all refuses while a bounded reviewed mutation is active, then removes only owned
/// worktree directories after it stops. No late materialization can recreate content after the wipe.
pub fn wipe(data: &Path) -> Result<(), String> {
    let _guard = MUTATIONS.try_lock().map_err(|_| "A reviewed repository operation is still stopping. Retry deletion to remove its private worktrees.")?;
    wipe_worktrees(data)
}

#[cfg(test)]
pub(super) async fn test_mutation_guard() -> tokio::sync::MutexGuard<'static, ()> {
    MUTATIONS.lock().await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reviewed_global_wipe_refuses_active_mutations_then_removes_only_owned_bytes() {
        let root = std::env::temp_dir().join(format!("fuse-review-wipe-{}", id().unwrap()));
        let private = root.join("code-worktrees").join(id().unwrap());
        std::fs::create_dir_all(&private).unwrap();
        std::fs::write(private.join("result.txt"), "synthetic retained result").unwrap();
        std::fs::write(root.join("keep.txt"), "unrelated data").unwrap();
        let guard = MUTATIONS.lock().await;
        assert!(wipe(&root).unwrap_err().contains("still stopping"));
        assert!(private.join("result.txt").exists());
        drop(guard);
        wipe(&root).unwrap();
        assert!(!private.exists());
        assert_eq!(
            std::fs::read_to_string(root.join("keep.txt")).unwrap(),
            "unrelated data"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
