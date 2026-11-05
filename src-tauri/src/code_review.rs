//! Read-only, bounded review snapshots. Refs are resolved once; subsequent object reads use
//! immutable IDs. No shell, external diff/textconv, lazy fetch, index refresh or repository write.
use crate::{ctx::Ctx, repo};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const FILES: usize = 20;
const FILE_BYTES: usize = 64 * 1024;
const TOTAL_BYTES: usize = 256 * 1024;
const OUTPUT: usize = 512 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub kind: String,
    pub base_ref: Option<String>,
    pub head_ref: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFile {
    pub path: String,
    pub old_revision: String,
    pub new_revision: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub changed_old: Vec<usize>,
    pub changed_new: Vec<usize>,
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub protocol: u8,
    pub id: String,
    pub label: String,
    pub base_commit: String,
    pub head_commit: String,
    pub files: Vec<ReviewFile>,
    pub limitations: Vec<String>,
}
fn hash(bytes: &[u8]) -> String {
    crate::sync::crypto::hex(&Sha256::digest(bytes))
}
fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|c| !matches!(c, "" | "." | ".." | ".git"))
}
fn safe_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
}
async fn git(root: &Path, args: &[&str]) -> Result<(i32, Vec<u8>), String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args([
        "--no-optional-locks",
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "diff.external=",
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
        "GIT_EXTERNAL_DIFF",
        "GIT_DIFF_OPTS",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_COUNT",
    ] {
        cmd.env_remove(key);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd
        .spawn()
        .map_err(|_| "Git is unavailable on this execution owner.")?;
    let stdout = child.stdout.take().ok_or("Git stdout is unavailable.")?;
    let stderr = child.stderr.take().ok_or("Git stderr is unavailable.")?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let mut output = vec![];
        let mut errors = vec![];
        let mut stdout = stdout.take((OUTPUT + 1) as u64);
        let mut stderr = stderr.take(8193);
        let (out, err) = tokio::join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut errors)
        );
        out.map_err(|_| "Couldn't read the Git snapshot.")?;
        err.map_err(|_| "Couldn't read Git's status.")?;
        if output.len() > OUTPUT || errors.len() > 8192 {
            return Err("Git review output exceeds its bounded capture limit.");
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "Git snapshot was interrupted.")?;
        Ok((status.code().unwrap_or(-1), output))
    })
    .await
    .map_err(|_| "Git review exceeded its 15-second operation limit.")?;
    // kill_on_drop also covers limit/error returns, including a child blocked on a full pipe.
    result.map_err(str::to_string)
}
async fn checked(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let (code, out) = git(root, args).await?;
    if code != 0 {
        return Err(
            "Git could not read the selected revision. Select an existing local commit or branch."
                .into(),
        );
    }
    Ok(out)
}
async fn commit(root: &Path, reference: &str) -> Result<String, String> {
    if !safe_ref(reference) {
        return Err("Choose a valid local revision.".into());
    }
    let spec = format!("{reference}^{{commit}}");
    let out = checked(root, &["rev-parse", "--verify", "--end-of-options", &spec]).await?;
    let out = String::from_utf8(out).map_err(|_| "Invalid Git commit identifier.")?;
    let out = out.trim();
    if out.len() != 40 || !out.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Review requires a complete 40-character Git commit identifier.".into());
    }
    Ok(out.to_ascii_lowercase())
}
async fn blob(root: &Path, revision: &str, path: &str) -> Result<Option<String>, String> {
    let entry = checked(root, &["ls-tree", "-z", revision, "--", path]).await?;
    if entry.is_empty() {
        return Ok(None);
    }
    let entry = std::str::from_utf8(&entry).map_err(|_| "Non-UTF8 Git path.")?;
    let (meta, actual) = entry
        .trim_end_matches('\0')
        .split_once('\t')
        .ok_or("Invalid Git tree entry.")?;
    let fields: Vec<_> = meta.split(' ').collect();
    if actual != path
        || fields.len() != 3
        || !matches!(fields[0], "100644" | "100755")
        || fields[1] != "blob"
    {
        return Err("Review skips symlinks, submodules and non-regular Git entries.".into());
    }
    let bytes = checked(root, &["cat-file", "blob", fields[2]]).await?;
    text(bytes).map(Some)
}
fn text(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > FILE_BYTES || bytes.contains(&0) {
        return Err("Review skips binary files and text larger than 64 KiB.".into());
    }
    String::from_utf8(bytes).map_err(|_| "Review skips non-UTF8 text.".into())
}
fn working_text(root: &Path, path: &str, allow_secrets: bool) -> Result<String, String> {
    // Reuse grant/ignore checks, then capture strictly decoded bytes through a bounded handle.
    repo::read(root, path, 0, allow_secrets)?;
    let resolved = repo::resolve(root, path)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(resolved)
        .map_err(|_| "The reviewed file is no longer readable.")?;
    if !file
        .metadata()
        .map_err(|_| "Cannot check the reviewed file.")?
        .is_file()
    {
        return Err("Review only reads regular files.".into());
    }
    let mut bytes = vec![];
    std::io::Read::read_to_end(
        &mut std::io::Read::take(file, (FILE_BYTES + 1) as u64),
        &mut bytes,
    )
    .map_err(|_| "Cannot capture the reviewed file.")?;
    text(bytes)
}
fn ranges(diff: &[u8]) -> Result<(Vec<usize>, Vec<usize>), String> {
    let diff = std::str::from_utf8(diff).map_err(|_| "Invalid text diff.")?;
    let mut old = BTreeSet::new();
    let mut new = BTreeSet::new();
    for line in diff.lines().filter(|s| s.starts_with("@@ ")) {
        let fields: Vec<_> = line.split_whitespace().collect();
        for (index, target, prefix) in [(1, &mut old, '-'), (2, &mut new, '+')] {
            let field = fields
                .get(index)
                .and_then(|s| s.strip_prefix(prefix))
                .ok_or("Invalid diff hunk.")?;
            let (start, count) = field.split_once(',').unwrap_or((field, "1"));
            let start: usize = start.parse().map_err(|_| "Invalid diff line.")?;
            let count: usize = count.parse().map_err(|_| "Invalid diff range.")?;
            if count > FILE_BYTES || start > 10_000_000 {
                return Err("Diff range exceeds review limits.".into());
            }
            target.extend(start..start + count);
        }
    }
    Ok((old.into_iter().collect(), new.into_iter().collect()))
}
async fn paths(root: &Path, old: &str, new: Option<&str>) -> Result<BTreeSet<String>, String> {
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        old,
    ];
    if let Some(new) = new {
        args.push(new);
    }
    args.push("--");
    let mut bytes = checked(root, &args).await?;
    if new.is_none() {
        bytes.extend(checked(root, &["ls-files", "--others", "--exclude-standard", "-z"]).await?);
    }
    std::str::from_utf8(&bytes)
        .map_err(|_| "Review cannot capture non-UTF8 filenames.".to_string())
        .map(|s| {
            s.split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
}
async fn capture(
    root: &Path,
    selection: &Selection,
    allow_secrets: bool,
) -> Result<Snapshot, String> {
    let top = checked(root, &["rev-parse", "--show-toplevel"]).await?;
    let top = std::str::from_utf8(&top)
        .map_err(|_| "Invalid repository root.")?
        .trim();
    if std::fs::canonicalize(top).map_err(|_| "The repository root is unavailable.")?
        != std::fs::canonicalize(root).map_err(|_| "The linked folder is unavailable.")?
    {
        return Err(
            "Review requires the granted repository root; Git points at a different working tree."
                .into(),
        );
    }
    let worktree = match selection.kind.as_str() {
        "changes" => true,
        "branch" => false,
        _ => return Err("Select local changes or a branch comparison.".into()),
    };
    let head = commit(root, selection.head_ref.as_deref().unwrap_or("HEAD")).await?;
    if worktree && selection.head_ref.as_deref().is_some_and(|s| s != "HEAD") {
        return Err("Local changes are compared to HEAD.".into());
    }
    let base = if worktree {
        head.clone()
    } else {
        let base = commit(
            root,
            selection
                .base_ref
                .as_deref()
                .ok_or("Choose a base revision.")?,
        )
        .await?;
        let merge = checked(root, &["merge-base", &base, &head]).await?;
        commit(
            root,
            std::str::from_utf8(&merge)
                .map_err(|_| "Invalid merge base.")?
                .trim(),
        )
        .await?
    };
    let selected = paths(root, &base, (!worktree).then_some(head.as_str())).await?;
    let mut snapshot = Snapshot {
        protocol: 1,
        id: String::new(),
        label: if worktree {
            "Local changes against HEAD"
        } else {
            "Branch changes against merge base"
        }
        .into(),
        base_commit: base.clone(),
        head_commit: head.clone(),
        files: vec![],
        limitations: vec![],
    };
    let mut total = 0;
    for path in &selected {
        if snapshot.files.len() >= FILES {
            snapshot
                .limitations
                .push("Only the first twenty eligible changed files were captured.".into());
            break;
        }
        if !safe_path(path) || (!allow_secrets && path.split('/').any(repo::is_secret)) {
            snapshot
                .limitations
                .push("An unsafe or secret-looking path was excluded.".into());
            continue;
        }
        let (ignored, _) = git(root, &["check-ignore", "--no-index", "-q", "--", path]).await?;
        if ignored == 0 {
            snapshot
                .limitations
                .push(format!("{path}: excluded by repository ignore rules."));
            continue;
        }
        if ignored != 1 {
            return Err("Couldn't verify the repository's ignore rules.".into());
        }
        let read: Result<Option<ReviewFile>, String> = async {
            let old = blob(root, &base, path).await?;
            let new =
                if worktree {
                    let joined = root.join(path);
                    match std::fs::symlink_metadata(&joined) {
                        Ok(meta)
                            if meta.is_file()
                                && !meta.file_type().is_symlink()
                                && meta.len() <= FILE_BYTES as u64 =>
                        {
                            Some(working_text(root, path, allow_secrets)?)
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                        _ => return Err(
                            "Review skips symlinks, non-regular files and text larger than 64 KiB."
                                .into(),
                        ),
                    }
                } else {
                    blob(root, &head, path).await?
                };
            let mut args = vec![
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--unified=0",
                &base,
            ];
            if !worktree {
                args.push(&head);
            }
            args.extend(["--", path]);
            let diff = checked(root, &args).await?;
            let (mut changed_old, mut changed_new) = ranges(&diff)?;
            if old.is_none() && new.is_some() {
                changed_new = (1..=new.as_deref().unwrap_or("").lines().count()).collect();
            }
            if new.is_none() && old.is_some() {
                changed_old = (1..=old.as_deref().unwrap_or("").lines().count()).collect();
            }
            if old == new {
                return Ok(None);
            }
            if changed_old.is_empty() && changed_new.is_empty() && old.is_some() && new.is_some() {
                return Err("Git supplied no complete text hunks; this file was excluded.".into());
            }
            Ok(Some(ReviewFile {
                path: path.clone(),
                old_revision: base.clone(),
                new_revision: if worktree {
                    format!("snapshot:{}", hash(new.as_deref().unwrap_or("").as_bytes()))
                } else {
                    head.clone()
                },
                old_text: old,
                new_text: new,
                changed_old,
                changed_new,
            }))
        }
        .await;
        match read {
            Ok(Some(file)) => {
                total += file.old_text.as_ref().map_or(0, String::len)
                    + file.new_text.as_ref().map_or(0, String::len);
                if total > TOTAL_BYTES {
                    snapshot
                        .limitations
                        .push("The 256 KiB source capture limit was reached.".into());
                    break;
                }
                snapshot.files.push(file);
            }
            Ok(None) => {}
            Err(error) => snapshot.limitations.push(format!("{path}: {error}")),
        }
    }
    if worktree {
        if commit(root, "HEAD").await? != head || paths(root, &base, None).await? != selected {
            return Err("Local changes moved during capture. Select them again explicitly.".into());
        }
        // Bind each included file's actual bytes, not a timestamp susceptible to clock skew.
        for file in &snapshot.files {
            let current = if file.new_text.is_some() {
                Some(working_text(root, &file.path, allow_secrets)?)
            } else if root.join(&file.path).exists() {
                return Err("A deleted file reappeared during capture. Select again.".into());
            } else {
                None
            };
            if current != file.new_text {
                return Err(
                    "A reviewed file changed during capture. Select again explicitly.".into(),
                );
            }
        }
    }
    snapshot.id =
        hash(&serde_json::to_vec(&snapshot).map_err(|_| "Couldn't identify the captured review.")?);
    Ok(snapshot)
}
pub(crate) async fn snapshot(
    ctx: &Ctx,
    folder_id: String,
    selection: Selection,
) -> Result<Snapshot, String> {
    let (root, secrets) = repo::folder_root(&ctx.db.pool()?, &folder_id).await?;
    let root = std::fs::canonicalize(root).map_err(|_| "The linked folder is unavailable.")?;
    tokio::time::timeout(
        Duration::from_secs(120),
        capture(&root, &selection, secrets),
    )
    .await
    .map_err(|_| "Review capture exceeded two minutes. Narrow the changed files.")?
}
pub mod commands {
    use super::*;
    #[tauri::command]
    pub async fn repo_review_snapshot(
        ctx: tauri::State<'_, Ctx>,
        folder_id: String,
        selection: Selection,
    ) -> Result<Snapshot, String> {
        snapshot(&ctx, folder_id, selection).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn git(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args([
                    "-c",
                    "user.name=Recorded review",
                    "-c",
                    "user.email=review@example.invalid",
                ])
                .args(args)
                .current_dir(&self.0)
                .output()
                .unwrap();
            assert!(output.status.success(), "fixture git failed: {:?}", args);
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        }
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "fuse-review-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            let f = Self(path);
            f.git(&["init", "--initial-branch=fixture"]);
            std::fs::write(f.0.join("notes.txt"), "first\nold\nlast\n").unwrap();
            f.git(&["add", "notes.txt"]);
            f.git(&["commit", "-m", "Recorded base"]);
            f
        }
        fn selection(&self, kind: &str, base: Option<String>) -> Selection {
            Selection {
                kind: kind.into(),
                base_ref: base,
                head_ref: None,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[tokio::test]
    async fn captures_dirty_staged_and_untracked_bytes_without_writes_or_external_diff() {
        let f = Fixture::new();
        f.git(&["config", "diff.external", "fuse-review-must-never-execute"]);
        std::fs::write(f.0.join("notes.txt"), "first\nnew\nlast\n").unwrap();
        f.git(&["add", "notes.txt"]);
        std::fs::write(f.0.join("new.txt"), "added\n").unwrap();
        let before = f.git(&["status", "--porcelain=v1"]);
        let index = std::fs::read(f.0.join(".git/index")).unwrap();
        let snapshot = capture(&f.0, &f.selection("changes", None), false)
            .await
            .unwrap();
        assert_eq!(snapshot.files.len(), 2);
        let file = snapshot
            .files
            .iter()
            .find(|v| v.path == "notes.txt")
            .unwrap();
        assert_eq!(file.changed_old, vec![2]);
        assert_eq!(file.changed_new, vec![2]);
        assert_eq!(file.new_text.as_deref(), Some("first\nnew\nlast\n"));
        assert!(file.new_revision.starts_with("snapshot:"));
        assert_eq!(before, f.git(&["status", "--porcelain=v1"]));
        assert_eq!(index, std::fs::read(f.0.join(".git/index")).unwrap());
        assert_eq!(snapshot.id.len(), 64);
    }
    #[tokio::test]
    async fn branches_pin_merge_base_and_preserve_deleted_file_evidence() {
        let f = Fixture::new();
        let base = f.git(&["rev-parse", "HEAD"]);
        f.git(&["switch", "-c", "reviewed"]);
        std::fs::remove_file(f.0.join("notes.txt")).unwrap();
        std::fs::write(f.0.join("replacement.txt"), "replacement\n").unwrap();
        f.git(&["add", "-A"]);
        f.git(&["commit", "-m", "Recorded head"]);
        let head = f.git(&["rev-parse", "HEAD"]);
        let snapshot = capture(&f.0, &f.selection("branch", Some(base.clone())), false)
            .await
            .unwrap();
        assert_eq!(snapshot.base_commit, base);
        assert_eq!(snapshot.head_commit, head);
        let deleted = snapshot
            .files
            .iter()
            .find(|v| v.path == "notes.txt")
            .unwrap();
        assert!(deleted.new_text.is_none());
        assert_eq!(deleted.changed_old, vec![1, 2, 3]);
        // Moving a branch after capture cannot change the retained bytes or revision.
        std::fs::write(f.0.join("replacement.txt"), "later edit\n").unwrap();
        assert_eq!(
            snapshot
                .files
                .iter()
                .find(|v| v.path == "replacement.txt")
                .unwrap()
                .new_text
                .as_deref(),
            Some("replacement\n")
        );
    }
    #[tokio::test]
    async fn excludes_secrets_ignored_binary_and_oversized_files_with_explicit_limits() {
        let f = Fixture::new();
        std::fs::write(f.0.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(f.0.join("ignored.txt"), "not captured").unwrap();
        std::fs::write(f.0.join("credential.key"), "synthetic private fixture").unwrap();
        std::fs::write(f.0.join("binary.bin"), [0, 1, 2]).unwrap();
        std::fs::write(f.0.join("large.txt"), vec![b'a'; FILE_BYTES + 1]).unwrap();
        let snapshot = capture(&f.0, &f.selection("changes", None), false)
            .await
            .unwrap();
        assert!(snapshot.files.iter().all(|v| v.path == ".gitignore"));
        assert!(snapshot.limitations.len() >= 3);
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains("synthetic private fixture")
        );
        assert!(commit(&f.0, "--output=bad").await.is_err());
        assert!(commit(&f.0, "absent-revision").await.is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_symlinks_and_external_targets() {
        let f = Fixture::new();
        std::os::unix::fs::symlink("notes.txt", f.0.join("link.txt")).unwrap();
        let snapshot = capture(&f.0, &f.selection("changes", None), false)
            .await
            .unwrap();
        assert!(snapshot.files.is_empty());
        assert!(snapshot.limitations.iter().any(|v| v.contains("symlink")));
        f.git(&["add", "link.txt"]);
        f.git(&["commit", "-m", "Recorded symlink"]);
        assert!(
            blob(&f.0, &commit(&f.0, "HEAD").await.unwrap(), "link.txt")
                .await
                .is_err()
        );
    }
    #[test]
    fn hunk_and_path_validation_handles_deletion_and_windows_boundaries() {
        assert_eq!(
            ranges(b"@@ -2,2 +2,0 @@\n-old\n-old\n").unwrap(),
            (vec![2, 3], vec![])
        );
        assert!(ranges(b"@@ -1,999999999 +1 @@").is_err());
        for path in [
            "../file",
            "C:/file",
            "folder\\file",
            ".git/config",
            "a/../b",
            "a\nfile",
        ] {
            assert!(!safe_path(path));
        }
        assert!(safe_path("folder/notes.txt"));
    }
}
