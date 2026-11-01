//! Attachment bytes on disk, content-addressed by SHA-256 under the app data dir (`files/<sha256>`).
//! The database keeps only metadata (see docs/data-model.md, `files`). Bytes cross IPC raw, not as
//! JSON, so a 10 MB image doesn't become a 30 MB number array.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ctx::Ctx;

/// Hard cap per file. Provider limits are lower (Anthropic: 32 MB per request), and images are
/// resized before they get here.
pub const MAX_FILE_BYTES: usize = 50 * 1024 * 1024;
const DIR: &str = "files";

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct StoredFile {
    pub sha256: String,
    pub size: usize,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn path_for(root: &Path, sha256: &str) -> PathBuf {
    root.join(DIR).join(sha256)
}

/// Writes the bytes once (same content, same file) and returns their hash and size.
pub fn put(root: &Path, bytes: &[u8]) -> Result<StoredFile, String> {
    if bytes.is_empty() {
        return Err("file is empty".into());
    }
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "file is larger than {} MB",
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let sha256 = hex(&Sha256::digest(bytes));
    let path = path_for(root, &sha256);
    if !path.exists() {
        let dir = root.join(DIR);
        fs::create_dir_all(&dir).map_err(|e| format!("can't create the files folder: {e}"))?;
        // Write to a temp name, then rename, so a crash never leaves a half-written file.
        let tmp = dir.join(format!("{sha256}.tmp"));
        let mut f = fs::File::create(&tmp).map_err(|e| format!("can't save the file: {e}"))?;
        f.write_all(bytes)
            .and_then(|()| f.sync_all())
            .map_err(|e| format!("can't save the file: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("can't save the file: {e}"))?;
    }
    Ok(StoredFile {
        sha256,
        size: bytes.len(),
    })
}

pub fn get(root: &Path, sha256: &str) -> Result<Vec<u8>, String> {
    if !is_sha256(sha256) {
        return Err("invalid file id".into());
    }
    fs::read(path_for(root, sha256)).map_err(|e| format!("can't read the file: {e}"))
}

/// Removes every stored attachment (SE-07 delete-all). Only files named by a SHA-256 in the
/// attachments folder are touched; returns how many were removed.
pub fn wipe(root: &Path) -> Result<usize, String> {
    let dir = root.join(DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_str().is_some_and(is_sha256) {
            fs::remove_file(entry.path()).map_err(|e| format!("can't remove a file: {e}"))?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Body: the raw file bytes.
pub(crate) fn file_put(
    ctx: &Ctx,
    body: Vec<u8>,
    _headers: &HashMap<String, String>,
) -> Result<StoredFile, String> {
    put(&ctx.data_dir, &body)
}

/// Returns the raw bytes.
pub(crate) fn file_get(ctx: &Ctx, sha256: String) -> Result<Vec<u8>, String> {
    get(&ctx.data_dir, &sha256)
}

/// Deletes every stored attachment (delete-all); returns how many.
pub(crate) fn file_wipe(ctx: &Ctx) -> Result<usize, String> {
    wipe(&ctx.data_dir)
}

pub mod commands {
    use super::*;
    use crate::ctx::request_parts;
    use tauri::State;
    use tauri::ipc::{Request, Response};

    #[tauri::command]
    pub fn file_put(ctx: State<'_, Ctx>, request: Request<'_>) -> Result<StoredFile, String> {
        let (body, headers) = request_parts(&request)?;
        super::file_put(&ctx, body, &headers)
    }

    #[tauri::command]
    pub fn file_get(ctx: State<'_, Ctx>, sha256: String) -> Result<Response, String> {
        Ok(Response::new(super::file_get(&ctx, sha256)?))
    }

    #[tauri::command]
    pub fn file_wipe(ctx: State<'_, Ctx>) -> Result<usize, String> {
        super::file_wipe(&ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipe_removes_stored_files_only() {
        let root = temp_root();
        let a = put(&root, b"one").unwrap();
        put(&root, b"two").unwrap();
        fs::write(root.join(DIR).join("notes.txt"), b"keep").unwrap();
        assert_eq!(wipe(&root).unwrap(), 2);
        assert!(get(&root, &a.sha256).is_err());
        assert!(root.join(DIR).join("notes.txt").exists());
        assert_eq!(wipe(&root.join("missing")).unwrap(), 0);
    }

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fuse-files-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn put_then_get_round_trips_and_dedupes() {
        let root = temp_root();
        let a = put(&root, b"hello").unwrap();
        assert_eq!(
            a.sha256,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(a.size, 5);
        assert_eq!(put(&root, b"hello").unwrap(), a);
        assert_eq!(get(&root, &a.sha256).unwrap(), b"hello");
        assert_eq!(fs::read_dir(root.join(DIR)).unwrap().count(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_empty_oversized_and_bad_ids() {
        let root = temp_root();
        assert!(put(&root, b"").is_err());
        assert!(put(&root, &vec![0u8; MAX_FILE_BYTES + 1]).is_err());
        // No path traversal: ids must be 64 lowercase hex characters.
        assert!(get(&root, "../../etc/passwd").is_err());
        assert!(get(&root, &"A".repeat(64)).is_err());
        assert!(get(&root, &"0".repeat(64)).is_err()); // valid id, no such file
    }
}
