//! A project's linked repository (CA-01, M6 step 3). The coding agent lists, reads and searches
//! files here, and only here: every path is checked against the project's root, which is looked
//! up from the database, never taken from the frontend's word. Files the repository ignores and
//! secret-looking files (`.env`, keys) are skipped unless the project allows them.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use ignore::WalkBuilder;
use ignore::gitignore::Gitignore;
use serde::Serialize;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;

/// The most one read returns; the agent asks for the next part with an offset.
pub const MAX_READ: u64 = 256 * 1024;
const MAX_LIST: usize = 2_000;
const MAX_HITS: usize = 200;
/// Files bigger than this aren't searched.
const MAX_SEARCH_FILE: u64 = 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// The folder, resolved (symlinks followed).
    pub root: String,
    pub name: String,
    pub is_git: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Relative to the root, with `/` on every platform.
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub secret: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub path: String,
    pub content: String,
    pub offset: u64,
    pub total_bytes: u64,
    /// More follows: read again from `offset + content's byte length`.
    pub truncated: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

/// Checks a folder before it's linked: it must exist and be a directory.
pub fn check(folder: &Path) -> Result<RepoInfo, String> {
    let root = fs::canonicalize(folder).map_err(|e| format!("Can't open that folder: {e}"))?;
    if !root.is_dir() {
        return Err("That isn't a folder.".into());
    }
    Ok(RepoInfo {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        is_git: root.join(".git").exists(),
        root: root.to_string_lossy().into_owned(),
    })
}

/// The file or folder `rel` names inside `root`, or why it can't be used. Relative paths only,
/// no `..`, and after following symlinks it must still be inside the root.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let rel_path = Path::new(rel);
    for c in rel_path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => return Err(format!("{rel}: `..` isn't allowed.")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("{rel}: use a path relative to the repository."));
            }
        }
    }
    let joined = root.join(rel_path);
    let real = fs::canonicalize(&joined).map_err(|_| format!("{rel}: no such file or folder."))?;
    if !real.starts_with(&root) {
        return Err(format!("{rel} is outside the repository."));
    }
    Ok(real)
}

fn check_components(rel: &str) -> Result<(), String> {
    if rel.trim().is_empty() {
        return Err("Name a file.".into());
    }
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(n) if n == ".git" => {
                return Err(format!("{rel}: the .git folder can't be changed."));
            }
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => return Err(format!("{rel}: `..` isn't allowed.")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("{rel}: use a path relative to the repository."));
            }
        }
    }
    Ok(())
}

/// Where a write, delete or move may go: like `resolve`, but the file needn't exist yet. Its
/// deepest existing folder must be inside the root (after symlinks), and so must the file if it
/// exists. Never inside `.git`; secret-looking names only when allowed.
pub fn resolve_target(root: &Path, rel: &str, allow_secrets: bool) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    check_components(rel)?;
    let joined = root.join(rel);
    let name = joined
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{rel}: name a file."))?;
    if !allow_secrets && is_secret(&name) {
        return Err(format!(
            "{rel} looks like it holds secrets, so it isn't changed. You can allow this in the \
             project's settings."
        ));
    }
    if joined.exists() || joined.is_symlink() {
        let real = fs::canonicalize(&joined).map_err(|e| format!("{rel}: {e}"))?;
        if !real.starts_with(&root) || real.components().any(|c| c.as_os_str() == ".git") {
            return Err(format!("{rel} is outside the repository."));
        }
        return Ok(real);
    }
    let mut existing = joined
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(root.clone());
    let mut rest = vec![name];
    while !existing.exists() {
        let Some(n) = existing.file_name() else { break };
        rest.push(n.to_string_lossy().into_owned());
        existing = existing
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or(root.clone());
    }
    let base = fs::canonicalize(&existing).map_err(|e| format!("{rel}: {e}"))?;
    if !base.starts_with(&root) {
        return Err(format!("{rel} is outside the repository."));
    }
    let mut out = base;
    for part in rest.iter().rev() {
        out = out.join(part);
    }
    Ok(out)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// What the file held before; None when it didn't exist. Kept so the change can be undone.
    pub before: Option<String>,
}

fn text_of(path: &Path, rel: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("{rel}: {e}"))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(format!("{rel} is a binary file, so it isn't changed."));
    }
    String::from_utf8(bytes).map_err(|_| format!("{rel} isn't UTF-8 text, so it isn't changed."))
}

/// Writes a text file (creating folders as needed), all at once: a temporary file in the same
/// folder, then a rename, so a crash never leaves half a file.
pub fn write(root: &Path, rel: &str, content: &str, allow_secrets: bool) -> Result<Change, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let path = resolve_target(&root, rel, allow_secrets)?;
    if path.is_dir() {
        return Err(format!("{rel} is a folder."));
    }
    let before = if path.exists() {
        Some(text_of(&path, rel)?)
    } else {
        None
    };
    let dir = path.parent().ok_or_else(|| format!("{rel}: no folder"))?;
    fs::create_dir_all(dir).map_err(|e| format!("{rel}: {e}"))?;
    let tmp = dir.join(format!(
        ".fuse-write-{}-{}",
        std::process::id(),
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    fs::write(&tmp, content).map_err(|e| format!("{rel}: {e}"))?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{rel}: {e}"));
    }
    Ok(Change {
        path: rel_string(&root, &path),
        before,
    })
}

/// Deletes a text file; returns what it held.
pub fn delete(root: &Path, rel: &str, allow_secrets: bool) -> Result<Change, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let path = resolve_target(&root, rel, allow_secrets)?;
    if !path.is_file() {
        return Err(format!("{rel}: no such file."));
    }
    let before = text_of(&path, rel)?;
    fs::remove_file(&path).map_err(|e| format!("{rel}: {e}"))?;
    Ok(Change {
        path: rel_string(&root, &path),
        before: Some(before),
    })
}

/// WF-04: writes a binary file (a Word, Excel or PDF document) all at once, like `write`. The
/// caller keeps what it replaced (it reads the old bytes first), for undo.
pub fn write_bytes(
    root: &Path,
    rel: &str,
    bytes: &[u8],
    allow_secrets: bool,
) -> Result<String, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let path = resolve_target(&root, rel, allow_secrets)?;
    if path.is_dir() {
        return Err(format!("{rel} is a folder."));
    }
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!(
            "{rel}: that's over {} MB.",
            MAX_BYTES / (1024 * 1024)
        ));
    }
    let dir = path.parent().ok_or_else(|| format!("{rel}: no folder"))?;
    fs::create_dir_all(dir).map_err(|e| format!("{rel}: {e}"))?;
    let tmp = dir.join(format!(
        ".fuse-write-{}-{}",
        std::process::id(),
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("{rel}: {e}"))?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{rel}: {e}"));
    }
    Ok(rel_string(&root, &path))
}

/// WF-04: removes a binary file FUSE made (undoing its creation); the caller checked its bytes.
pub fn remove_bytes(root: &Path, rel: &str, allow_secrets: bool) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let path = resolve_target(&root, rel, allow_secrets)?;
    if !path.is_file() {
        return Err(format!("{rel}: no such file."));
    }
    fs::remove_file(&path).map_err(|e| format!("{rel}: {e}"))
}

/// Moves or renames a file inside the repository; never over an existing one.
pub fn rename(root: &Path, from: &str, to: &str, allow_secrets: bool) -> Result<Change, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let src = resolve_target(&root, from, allow_secrets)?;
    if !src.is_file() {
        return Err(format!("{from}: no such file."));
    }
    let dst = resolve_target(&root, to, allow_secrets)?;
    if dst.exists() {
        return Err(format!("{to} already exists."));
    }
    if let Some(dir) = dst.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{to}: {e}"))?;
    }
    fs::rename(&src, &dst).map_err(|e| format!("{from} → {to}: {e}"))?;
    Ok(Change {
        path: rel_string(&root, &dst),
        before: None,
    })
}

/// Names that usually hold credentials. The agent doesn't read them unless the project says so.
pub fn is_secret(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == ".env"
        || (n.starts_with(".env.") && !n.ends_with(".example") && !n.ends_with(".sample"))
        || n.ends_with(".pem")
        || n.ends_with(".key")
        || n.ends_with(".p12")
        || n.ends_with(".pfx")
        || n.ends_with(".keystore")
        || n.starts_with("id_rsa")
        || n.starts_with("id_ed25519")
        || n.starts_with("id_ecdsa")
        || n == ".npmrc"
        || n == ".netrc"
        || n == ".pypirc"
        || n == "credentials"
        || n == "credentials.json"
        || n == "secrets.json"
}

fn rel_string(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn walker(dir: &Path, depth: Option<usize>) -> WalkBuilder {
    let mut w = WalkBuilder::new(dir);
    // Dotfiles like .github are shown; .git itself never is. Ignore rules apply even when the
    // folder isn't a git repository yet.
    w.hidden(false)
        .require_git(false)
        .max_depth(depth)
        .filter_entry(|e| e.file_name() != ".git")
        .sort_by_file_path(|a, b| a.cmp(b));
    w
}

/// Whether the repository's ignore rules (any `.gitignore` from the root down) exclude `path`.
pub fn is_ignored(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    if rel.components().any(|c| c.as_os_str() == ".git") {
        return true;
    }
    let is_dir = path.is_dir();
    // The deepest .gitignore that has an opinion wins.
    let mut dirs = vec![root.to_path_buf()];
    let mut d = root.to_path_buf();
    if let Some(parent) = rel.parent() {
        for c in parent.components() {
            d = d.join(c);
            dirs.push(d.clone());
        }
    }
    for dir in dirs.iter().rev() {
        let file = dir.join(".gitignore");
        if !file.is_file() {
            continue;
        }
        let (gi, _) = Gitignore::new(&file);
        let m = gi.matched_path_or_any_parents(path, is_dir);
        if m.is_ignore() {
            return true;
        }
        if m.is_whitelist() {
            return false;
        }
    }
    false
}

/// What's in a folder (or under it, with `recursive`), ignored files left out.
pub fn list(root: &Path, rel: &str, recursive: bool) -> Result<Vec<Entry>, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let dir = resolve(&root, rel)?;
    if !dir.is_dir() {
        return Err(format!("{rel} is a file, not a folder."));
    }
    let mut out = Vec::new();
    for e in walker(&dir, if recursive { None } else { Some(1) }).build() {
        let Ok(e) = e else { continue };
        if e.path() == dir {
            continue;
        }
        let meta = e.metadata().ok();
        out.push(Entry {
            path: rel_string(&root, e.path()),
            dir: e.file_type().is_some_and(|t| t.is_dir()),
            size: meta.map(|m| m.len()).unwrap_or(0),
            secret: is_secret(&e.file_name().to_string_lossy()),
        });
        if out.len() >= MAX_LIST {
            break;
        }
    }
    Ok(out)
}

fn readable(root: &Path, path: &Path, rel: &str, allow_secrets: bool) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{rel} is a folder, not a file."));
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !allow_secrets && is_secret(&name) {
        return Err(format!(
            "{rel} looks like it holds secrets, so it isn't read. You can allow this in the \
             project's settings."
        ));
    }
    if is_ignored(root, path) {
        return Err(format!("{rel} is ignored by the repository's .gitignore."));
    }
    Ok(())
}

/// Up to `MAX_READ` bytes of a text file, from `offset`.
pub fn read(root: &Path, rel: &str, offset: u64, allow_secrets: bool) -> Result<FileText, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let path = resolve(&root, rel)?;
    readable(&root, &path, rel, allow_secrets)?;
    let mut f = fs::File::open(&path).map_err(|e| format!("{rel}: {e}"))?;
    let total = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = vec![0u8; 8192.min(total as usize)];
    f.read_exact(&mut head).map_err(|e| format!("{rel}: {e}"))?;
    if head.contains(&0) {
        return Err(format!("{rel} is a binary file."));
    }
    let start = offset.min(total);
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("{rel}: {e}"))?;
    let mut buf = Vec::new();
    f.take(MAX_READ)
        .read_to_end(&mut buf)
        .map_err(|e| format!("{rel}: {e}"))?;
    // Don't cut a character in half at the end of a part.
    let mut end = buf.len();
    while end > 0 && std::str::from_utf8(&buf[..end]).is_err() && buf.len() - end < 4 {
        end -= 1;
    }
    buf.truncate(end);
    let read = buf.len() as u64;
    Ok(FileText {
        path: rel_string(&root, &path),
        content: String::from_utf8_lossy(&buf).into_owned(),
        offset: start,
        total_bytes: total,
        truncated: start + read < total,
    })
}

/// The most a document read (WF-03) takes in one go: Word, Excel and PDF files are read whole.
pub const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// A whole file's bytes (WF-03: documents and images), with the same path, ignore and secret
/// rules as `read`.
pub fn read_bytes(root: &Path, rel: &str, allow_secrets: bool) -> Result<Vec<u8>, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let path = resolve(&root, rel)?;
    readable(&root, &path, rel, allow_secrets)?;
    let size = fs::metadata(&path)
        .map_err(|e| format!("{rel}: {e}"))?
        .len();
    if size > MAX_BYTES {
        return Err(format!(
            "{rel} is {:.0} MB; documents over {} MB aren't read.",
            size as f64 / 1e6,
            MAX_BYTES / (1024 * 1024)
        ));
    }
    fs::read(&path).map_err(|e| format!("{rel}: {e}"))
}

/// Lines containing `query`, in text files under `rel`, ignored and secret files left out.
pub fn search(
    root: &Path,
    rel: &str,
    query: &str,
    ignore_case: bool,
    allow_secrets: bool,
) -> Result<Vec<Hit>, String> {
    if query.is_empty() {
        return Err("Search for something.".into());
    }
    let root = fs::canonicalize(root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    let dir = resolve(&root, rel)?;
    let needle = if ignore_case {
        query.to_lowercase()
    } else {
        query.to_string()
    };
    let mut hits = Vec::new();
    for e in walker(&dir, None).build() {
        let Ok(e) = e else { continue };
        if !e.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if !allow_secrets && is_secret(&e.file_name().to_string_lossy()) {
            continue;
        }
        if e.metadata().map(|m| m.len()).unwrap_or(0) > MAX_SEARCH_FILE {
            continue;
        }
        let Ok(bytes) = fs::read(e.path()) else {
            continue;
        };
        if bytes.iter().take(8192).any(|b| *b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            let hay = if ignore_case {
                line.to_lowercase()
            } else {
                line.to_string()
            };
            if hay.contains(&needle) {
                hits.push(Hit {
                    path: rel_string(&root, e.path()),
                    line: i + 1,
                    text: line.trim().chars().take(300).collect(),
                });
                if hits.len() >= MAX_HITS {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

/// A granted folder (WF-02) by id: its path and whether it may read secret-looking files.
/// The path comes from the database, never from the webview.
pub async fn folder_root(pool: &SqlitePool, folder_id: &str) -> Result<(PathBuf, bool), String> {
    let row = sqlx::query("SELECT path, read_sensitive FROM folders WHERE id = ?")
        .bind(folder_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Couldn't read the folder: {e}"))?
        .ok_or("That folder isn't granted to FUSE.")?;
    let root: String = row.get("path");
    let secrets: i64 = row.get("read_sensitive");
    Ok((PathBuf::from(root), secrets == 1))
}

pub mod commands {
    use super::*;
    use crate::db::Database;
    use tauri::{AppHandle, State};
    use tauri_plugin_dialog::DialogExt;

    /// The native folder picker; None when cancelled.
    #[tauri::command]
    pub async fn repo_pick(app: AppHandle) -> Result<Option<RepoInfo>, String> {
        let Some(folder) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = folder.into_path().map_err(|e| e.to_string())?;
        check(&path).map(Some)
    }

    #[tauri::command]
    pub fn repo_check(path: String) -> Result<RepoInfo, String> {
        check(Path::new(&path))
    }

    #[tauri::command]
    pub async fn repo_list(
        db: State<'_, Database>,
        folder_id: String,
        path: String,
        recursive: bool,
    ) -> Result<Vec<Entry>, String> {
        let (root, _) = folder_root(&db.pool()?, &folder_id).await?;
        list(&root, &path, recursive)
    }

    #[tauri::command]
    pub async fn repo_read(
        db: State<'_, Database>,
        folder_id: String,
        path: String,
        offset: u64,
    ) -> Result<FileText, String> {
        let (root, secrets) = folder_root(&db.pool()?, &folder_id).await?;
        read(&root, &path, offset, secrets)
    }

    /// WF-03: a whole file's raw bytes, for documents and images.
    #[tauri::command]
    pub async fn repo_read_bytes(
        db: State<'_, Database>,
        folder_id: String,
        path: String,
    ) -> Result<tauri::ipc::Response, String> {
        let (root, secrets) = folder_root(&db.pool()?, &folder_id).await?;
        read_bytes(&root, &path, secrets).map(tauri::ipc::Response::new)
    }

    /// WF-04: body = the bytes; headers `x-folder-id` and `x-path` (URI-encoded).
    #[tauri::command]
    pub async fn repo_write_bytes(
        db: State<'_, Database>,
        request: tauri::ipc::Request<'_>,
    ) -> Result<String, String> {
        let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
            return Err("expected raw bytes".into());
        };
        let header = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(percent_decode)
                .ok_or(format!("missing {name}"))
        };
        let folder_id = header("x-folder-id")?;
        let path = header("x-path")?;
        let (root, secrets) = folder_root(&db.pool()?, &folder_id).await?;
        write_bytes(&root, &path, bytes, secrets)
    }

    #[tauri::command]
    pub async fn repo_remove_bytes(
        db: State<'_, Database>,
        folder_id: String,
        path: String,
    ) -> Result<(), String> {
        let (root, secrets) = folder_root(&db.pool()?, &folder_id).await?;
        remove_bytes(&root, &path, secrets)
    }

    /// `%XX` escapes back to bytes (headers carry only ASCII); invalid UTF-8 is replaced.
    fn percent_decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%'
                && i + 2 < b.len()
                && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
            {
                out.push(v);
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tauri::command]
    pub async fn repo_write(
        db: State<'_, Database>,
        folder_id: String,
        path: String,
        content: String,
    ) -> Result<Change, String> {
        let (root, secrets) = folder_root(&db.pool()?, &folder_id).await?;
        write(&root, &path, &content, secrets)
    }

    #[tauri::command]
    pub async fn repo_delete(
        db: State<'_, Database>,
        folder_id: String,
        path: String,
    ) -> Result<Change, String> {
        let (root, secrets) = folder_root(&db.pool()?, &folder_id).await?;
        delete(&root, &path, secrets)
    }

    #[tauri::command]
    pub async fn repo_move(
        db: State<'_, Database>,
        folder_id: String,
        from: String,
        to: String,
    ) -> Result<Change, String> {
        let (root, secrets) = folder_root(&db.pool()?, &folder_id).await?;
        rename(&root, &from, &to, secrets)
    }

    #[tauri::command]
    pub async fn repo_search(
        db: State<'_, Database>,
        folder_id: String,
        path: String,
        query: String,
        ignore_case: bool,
    ) -> Result<Vec<Hit>, String> {
        let (root, secrets) = folder_root(&db.pool()?, &folder_id).await?;
        search(&root, &path, &query, ignore_case, secrets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small repository: README, src/main.rs, an ignored build folder, a .env and .git.
    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fuse-repo-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("build")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("docs/drafts")).unwrap();
        fs::write(
            dir.join("README.md"),
            "# Lighthouse\nPrints the tide table.\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/main.rs"),
            "fn main() {\n    println!(\"tide\");\n}\n",
        )
        .unwrap();
        fs::write(dir.join("build/out.txt"), "tide\n").unwrap();
        fs::write(dir.join(".env"), "TOKEN=tide\n").unwrap();
        fs::write(dir.join(".env.example"), "TOKEN=\n").unwrap();
        fs::write(dir.join(".git/config"), "[core]\n").unwrap();
        fs::write(dir.join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::write(dir.join("debug.log"), "tide\n").unwrap();
        fs::write(dir.join("docs/drafts/.gitignore"), "!keep.log\n").unwrap();
        fs::write(dir.join("docs/drafts/keep.log"), "tide\n").unwrap();
        fs::write(dir.join("logo.bin"), [0u8, 1, 2, 3]).unwrap();
        dir
    }

    #[test]
    fn paths_outside_the_root_are_refused() {
        let r = repo();
        assert!(resolve(&r, "README.md").is_ok());
        assert!(resolve(&r, "./src/main.rs").is_ok());
        assert!(resolve(&r, "src/../README.md").unwrap_err().contains(".."));
        assert!(resolve(&r, "../outside").unwrap_err().contains(".."));
        let abs = r.join("README.md").to_string_lossy().into_owned();
        assert!(resolve(&r, &abs).unwrap_err().contains("relative"));
        assert!(resolve(&r, "nope.txt").unwrap_err().contains("no such"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_root_is_refused() {
        let r = repo();
        let outside = r.with_extension("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, r.join("escape")).unwrap();
        std::os::unix::fs::symlink(r.join("README.md"), r.join("inside")).unwrap();
        assert!(
            resolve(&r, "escape/secret.txt")
                .unwrap_err()
                .contains("outside")
        );
        assert!(resolve(&r, "inside").is_ok());
    }

    #[test]
    fn ignored_files_and_git_are_left_out_of_lists() {
        let r = repo();
        let all: Vec<String> = list(&r, "", true)
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert!(all.contains(&"README.md".to_string()));
        assert!(all.contains(&"src/main.rs".to_string()));
        assert!(all.contains(&"docs/drafts/keep.log".to_string()));
        assert!(!all.iter().any(|p| p.starts_with("build")));
        assert!(!all.iter().any(|p| p.starts_with(".git/")));
        assert!(!all.contains(&"debug.log".to_string()));
        let top: Vec<String> = list(&r, "", false)
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert!(top.contains(&"src".to_string()));
        assert!(!top.contains(&"src/main.rs".to_string()));
        let env = list(&r, "", false)
            .unwrap()
            .into_iter()
            .find(|e| e.path == ".env")
            .unwrap();
        assert!(env.secret);
    }

    #[test]
    fn reads_refuse_ignored_secret_and_binary_files() {
        let r = repo();
        assert_eq!(
            read(&r, "README.md", 0, false).unwrap().content,
            "# Lighthouse\nPrints the tide table.\n"
        );
        assert!(
            read(&r, "build/out.txt", 0, false)
                .unwrap_err()
                .contains("ignored")
        );
        assert!(
            read(&r, "debug.log", 0, false)
                .unwrap_err()
                .contains("ignored")
        );
        assert!(read(&r, "docs/drafts/keep.log", 0, false).is_ok());
        assert!(read(&r, ".env", 0, false).unwrap_err().contains("secrets"));
        assert!(read(&r, ".env", 0, true).is_ok());
        assert!(read(&r, ".env.example", 0, false).is_ok());
        assert!(
            read(&r, "logo.bin", 0, false)
                .unwrap_err()
                .contains("binary")
        );
        assert!(read(&r, "src", 0, false).unwrap_err().contains("folder"));
        assert!(read(&r, ".git/config", 0, false).is_err());
    }

    #[test]
    fn long_files_are_read_in_parts() {
        let r = repo();
        let big = "a".repeat((MAX_READ as usize) + 10);
        fs::write(r.join("big.txt"), &big).unwrap();
        let first = read(&r, "big.txt", 0, false).unwrap();
        assert!(first.truncated);
        assert_eq!(first.content.len() as u64, MAX_READ);
        let rest = read(&r, "big.txt", MAX_READ, false).unwrap();
        assert!(!rest.truncated);
        assert_eq!(rest.content.len(), 10);
    }

    #[test]
    fn search_skips_ignored_secret_and_binary_files() {
        let r = repo();
        let hits = search(&r, "", "tide", false, false).unwrap();
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, ["README.md", "docs/drafts/keep.log", "src/main.rs"]);
        assert_eq!(hits[2].line, 2);
        assert!(search(&r, "", "TIDE", true, false).unwrap().len() == 3);
        assert!(
            search(&r, "", "tide", false, true)
                .unwrap()
                .iter()
                .any(|h| h.path == ".env")
        );
        assert!(search(&r, "../", "tide", false, false).is_err());
    }

    #[test]
    fn secret_names() {
        for n in [
            ".env",
            ".env.local",
            "id_rsa",
            "id_ed25519.pub",
            "server.pem",
            "x.key",
            ".npmrc",
        ] {
            assert!(is_secret(n), "{n}");
        }
        for n in [
            ".env.example",
            ".env.sample",
            "README.md",
            "keyboard.rs",
            "env.ts",
        ] {
            assert!(!is_secret(n), "{n}");
        }
    }

    #[test]
    fn writes_create_replace_and_report_what_was_there() {
        let r = repo();
        let made = write(&r, "src/new/mod.rs", "pub fn x() {}\n", false).unwrap();
        assert_eq!(
            made,
            Change {
                path: "src/new/mod.rs".into(),
                before: None
            }
        );
        assert_eq!(
            fs::read_to_string(r.join("src/new/mod.rs")).unwrap(),
            "pub fn x() {}\n"
        );
        let changed = write(&r, "README.md", "# Tide\n", false).unwrap();
        assert_eq!(
            changed.before.as_deref(),
            Some("# Lighthouse\nPrints the tide table.\n")
        );
        assert!(!fs::read_dir(r.join("src/new")).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".fuse-write")
        }));
    }

    #[test]
    fn writes_are_refused_outside_the_root_in_git_and_on_secrets() {
        let r = repo();
        assert!(
            write(&r, "../x.txt", "x", false)
                .unwrap_err()
                .contains("..")
        );
        assert!(
            write(&r, ".git/config", "x", false)
                .unwrap_err()
                .contains(".git")
        );
        assert!(
            write(&r, "src/.git/hooks/pre-commit", "x", false)
                .unwrap_err()
                .contains(".git")
        );
        assert!(
            write(&r, ".env", "x", false)
                .unwrap_err()
                .contains("secrets")
        );
        assert!(write(&r, ".env", "x", true).is_ok());
        assert!(write(&r, "src", "x", false).unwrap_err().contains("folder"));
        assert!(
            write(&r, "logo.bin", "x", false)
                .unwrap_err()
                .contains("binary")
        );
        assert!(write(&r, "", "x", false).is_err());
        let abs = r.join("y.txt").to_string_lossy().into_owned();
        assert!(
            write(&r, &abs, "x", false)
                .unwrap_err()
                .contains("relative")
        );
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlink_out_of_the_root_are_refused() {
        let r = repo();
        let outside = r.with_extension("outside-w");
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, r.join("out")).unwrap();
        assert!(
            write(&r, "out/new.txt", "x", false)
                .unwrap_err()
                .contains("outside")
        );
        assert!(!outside.join("new.txt").exists());
    }

    #[test]
    fn delete_and_move() {
        let r = repo();
        let gone = delete(&r, "src/main.rs", false).unwrap();
        assert!(gone.before.unwrap().contains("println"));
        assert!(!r.join("src/main.rs").exists());
        assert!(delete(&r, "src/main.rs", false).is_err());
        rename(&r, "README.md", "docs/README.md", false).unwrap();
        assert!(r.join("docs/README.md").exists() && !r.join("README.md").exists());
        assert!(
            rename(&r, "docs/README.md", ".gitignore", false)
                .unwrap_err()
                .contains("exists")
        );
        assert!(rename(&r, "docs/README.md", "../README.md", false).is_err());
    }

    #[tokio::test]
    async fn the_root_comes_from_the_database() {
        use crate::db::{Opened, execute, open};
        use crate::keys::MemoryStore;
        let dir = repo().with_extension("db");
        let pool = match open(&dir, &MemoryStore::default()).await.unwrap() {
            Opened::Ready(p) => p,
            Opened::NeedsRecoveryKey => panic!("expected the database to open"),
        };
        let r = repo();
        // WF-02: the root comes from the granted folder's row, never from the caller.
        execute(
            &pool,
            "INSERT INTO folders (id, workspace_id, user_id, path, read_sensitive, created_at, updated_at)
             SELECT 'f1', workspace_id, id, ?, 1, 1, 1 FROM users LIMIT 1",
            &[serde_json::Value::String(r.to_string_lossy().into_owned())],
        )
        .await
        .unwrap();
        let (root, secrets) = folder_root(&pool, "f1").await.unwrap();
        assert_eq!(root, r);
        assert!(secrets);
        assert!(
            folder_root(&pool, "missing")
                .await
                .unwrap_err()
                .contains("isn't granted")
        );
    }

    #[test]
    fn binary_files_are_written_whole_and_removed_with_the_path_rules() {
        let r = repo();
        let bytes = [0x50u8, 0x4b, 0, 0, 7];
        assert_eq!(
            write_bytes(&r, "out/report.docx", &bytes, false).unwrap(),
            "out/report.docx"
        );
        assert_eq!(fs::read(r.join("out/report.docx")).unwrap(), bytes);
        assert!(write_bytes(&r, "../x.docx", &bytes, false).is_err());
        assert!(write_bytes(&r, ".git/x", &bytes, false).is_err());
        remove_bytes(&r, "out/report.docx", false).unwrap();
        assert!(!r.join("out/report.docx").exists());
        assert!(remove_bytes(&r, "out/report.docx", false).is_err());
    }

    #[test]
    fn whole_files_as_bytes_keep_the_path_rules() {
        let r = repo();
        fs::write(r.join("report.docx"), [0x50, 0x4b, 0x03, 0x04, 0, 1, 2]).unwrap();
        assert_eq!(
            read_bytes(&r, "report.docx", false).unwrap()[..4],
            [0x50, 0x4b, 0x03, 0x04]
        );
        assert!(read_bytes(&r, "../outside.docx", false).is_err());
        assert!(read_bytes(&r, ".git/config", false).is_err());
        fs::write(r.join(".env"), "KEY=1").unwrap();
        assert!(read_bytes(&r, ".env", false).is_err());
        assert!(read_bytes(&r, ".env", true).is_ok());
    }

    #[test]
    fn checking_a_folder() {
        let r = repo();
        let info = check(&r).unwrap();
        assert!(info.is_git);
        assert!(check(&r.join("README.md")).unwrap_err().contains("folder"));
        assert!(check(&r.join("missing")).is_err());
    }
}
