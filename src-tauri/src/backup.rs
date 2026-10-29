//! Backup and restore (PL-11). Every backup is a copy of the SQLCipher-encrypted database file,
//! so it stays encrypted with the same key. Copies are made before each update's migrations
//! (`db::backup_before_migrations`) and on demand. A restore is only requested while the app
//! runs; it is applied on the next start, before the database opens, and the database it
//! replaces is kept as a backup too. Attachment bytes (`files/<sha256>`) are content-addressed,
//! so an integrity check re-hashes them against the database rows.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqlitePool;

use crate::db::{DB_FILE, is_plaintext, prune_backups};

const BACKUPS_DIR: &str = "backups";
/// Holds the name of the backup to restore at the next start.
const RESTORE_MARKER: &str = "restore.pending";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub created_ms: u64,
    pub bytes: u64,
    /// `update` (before migrations), `manual`, or `before_restore`.
    pub reason: &'static str,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileCheck {
    pub checked: usize,
    /// Hashes in the database with no file on disk.
    pub missing: Vec<String>,
    /// Files whose bytes no longer match their name.
    pub changed: Vec<String>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// `fuse-<ms>.db`, `fuse-<ms>-manual.db` or `fuse-<ms>-before-restore.db`; nothing with a path.
fn parse_name(name: &str) -> Option<(u64, &'static str)> {
    let stem = name.strip_prefix("fuse-")?.strip_suffix(".db")?;
    let (ms, reason) = match stem.split_once('-') {
        None => (stem, "update"),
        Some((ms, "manual")) => (ms, "manual"),
        Some((ms, "before-restore")) => (ms, "before_restore"),
        Some(_) => return None,
    };
    if ms.is_empty() || !ms.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((ms.parse().ok()?, reason))
}

/// Copies a database file and any WAL side files under a new name.
fn copy_with_sides(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::copy(from, to)?;
    for ext in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{ext}", from.display()));
        let target = PathBuf::from(format!("{}{ext}", to.display()));
        if side.exists() {
            fs::copy(&side, &target)?;
        } else {
            let _ = fs::remove_file(&target);
        }
    }
    Ok(())
}

/// Backups in `dir`, newest first.
pub fn list(dir: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = fs::read_dir(dir.join(BACKUPS_DIR)) else {
        return Vec::new();
    };
    let mut out: Vec<BackupInfo> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let (created_ms, reason) = parse_name(&name)?;
            let bytes = e.metadata().ok()?.len();
            Some(BackupInfo {
                name,
                created_ms,
                bytes,
                reason,
            })
        })
        .collect();
    out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms).then(b.name.cmp(&a.name)));
    out
}

/// Copies the open database to `backups/` now. Writers wait while the file is copied, so the
/// copy (database plus WAL) is consistent.
pub async fn backup_now(dir: &Path, pool: &SqlitePool) -> Result<BackupInfo, String> {
    let fail = |e: String| format!("Couldn't back up the database: {e}");
    let db = dir.join(DB_FILE);
    if is_plaintext(&db) {
        return Err(fail("it isn't encrypted".into()));
    }
    // Fold the WAL into the main file first when nothing is reading (best effort).
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(pool)
        .await;
    let backups = dir.join(BACKUPS_DIR);
    fs::create_dir_all(&backups).map_err(|e| fail(e.to_string()))?;
    let name = format!("fuse-{}-manual.db", now_ms());
    let target = backups.join(&name);

    let mut conn = pool.acquire().await.map_err(|e| fail(e.to_string()))?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|e| fail(e.to_string()))?;
    let copied = copy_with_sides(&db, &target);
    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
    drop(conn);
    copied.map_err(|e| fail(e.to_string()))?;

    prune_backups(&backups).map_err(|e| fail(e.to_string()))?;
    list(dir)
        .into_iter()
        .find(|b| b.name == name)
        .ok_or_else(|| fail("the copy is missing".into()))
}

/// Asks for `name` to be restored at the next start.
pub fn request_restore(dir: &Path, name: &str) -> Result<(), String> {
    if parse_name(name).is_none() || !dir.join(BACKUPS_DIR).join(name).is_file() {
        return Err("That backup doesn't exist.".into());
    }
    fs::write(dir.join(RESTORE_MARKER), name).map_err(|e| format!("Couldn't plan the restore: {e}"))
}

/// Applies a requested restore, before the database opens. The current database is kept as a
/// `before-restore` backup. Returns the name restored, if any.
pub fn apply_pending_restore(dir: &Path) -> Result<Option<String>, String> {
    let marker = dir.join(RESTORE_MARKER);
    let Ok(name) = fs::read_to_string(&marker) else {
        return Ok(None);
    };
    let name = name.trim().to_string();
    // Whatever happens next, don't try again on every start.
    let _ = fs::remove_file(&marker);
    let fail = |e: String| format!("Couldn't restore the backup: {e}");
    let backups = dir.join(BACKUPS_DIR);
    let source = backups.join(&name);
    if parse_name(&name).is_none() || !source.is_file() {
        return Err(fail("it no longer exists".into()));
    }
    if is_plaintext(&source) {
        return Err(fail("it isn't encrypted".into()));
    }
    let db = dir.join(DB_FILE);
    if db.exists() {
        let kept = backups.join(format!("fuse-{}-before-restore.db", now_ms()));
        copy_with_sides(&db, &kept).map_err(|e| fail(e.to_string()))?;
    }
    for ext in ["-wal", "-shm"] {
        let _ = fs::remove_file(dir.join(format!("{DB_FILE}{ext}")));
    }
    copy_with_sides(&source, &db).map_err(|e| fail(e.to_string()))?;
    let _ = prune_backups(&backups);
    Ok(Some(name))
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Re-hashes each attachment the database knows about (`files_root/files/<sha256>`).
pub fn check_files(files_root: &Path, hashes: &[String]) -> FileCheck {
    let mut out = FileCheck::default();
    let mut seen = std::collections::BTreeSet::new();
    for sha in hashes {
        if !seen.insert(sha.as_str()) {
            continue;
        }
        out.checked += 1;
        let path = files_root.join("files").join(sha);
        if !is_sha256(sha) {
            out.changed.push(sha.clone());
            continue;
        }
        match fs::read(&path) {
            Err(_) => out.missing.push(sha.clone()),
            Ok(bytes) => {
                let actual: String = Sha256::digest(&bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                if &actual != sha {
                    out.changed.push(sha.clone());
                }
            }
        }
    }
    out
}

pub mod commands {
    use super::*;
    use crate::db::{Database, commands::data_dir};
    use tauri::{AppHandle, Manager, State};

    #[tauri::command]
    pub fn backup_list(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
        Ok(list(&data_dir(&app)?))
    }

    #[tauri::command]
    pub async fn backup_now(app: AppHandle, db: State<'_, Database>) -> Result<BackupInfo, String> {
        super::backup_now(&data_dir(&app)?, &db.pool()?).await
    }

    /// Plans the restore and restarts the app, which applies it before the database opens.
    #[tauri::command]
    pub fn backup_restore(app: AppHandle, name: String) -> Result<(), String> {
        request_restore(&data_dir(&app)?, &name)?;
        app.restart();
    }

    #[tauri::command]
    pub async fn files_check(app: AppHandle, db: State<'_, Database>) -> Result<FileCheck, String> {
        let rows = crate::db::select(
            &db.pool()?,
            "SELECT DISTINCT sha256 FROM files WHERE deleted_at IS NULL",
            &[],
        )
        .await?;
        let hashes: Vec<String> = rows
            .into_iter()
            .filter_map(|r| r.get("sha256").and_then(|v| v.as_str()).map(String::from))
            .collect();
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        Ok(check_files(&root, &hashes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Opened, open};
    use crate::keys::MemoryStore;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("fuse-backup-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn titles(pool: &SqlitePool) -> Vec<String> {
        sqlx::query_scalar("SELECT title FROM threads ORDER BY title")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    async fn add_thread(pool: &SqlitePool, id: &str, title: &str) {
        sqlx::query(
            "INSERT INTO threads (id, workspace_id, user_id, title, created_at, updated_at)
             SELECT ?, workspace_id, id, ?, 1, 1 FROM users LIMIT 1",
        )
        .bind(id)
        .bind(title)
        .execute(pool)
        .await
        .unwrap();
    }

    fn ready(o: Opened) -> SqlitePool {
        match o {
            Opened::Ready(p) => p,
            Opened::NeedsRecoveryKey => panic!("expected the database to open"),
        }
    }

    #[test]
    fn names_are_parsed_strictly() {
        assert_eq!(parse_name("fuse-12.db"), Some((12, "update")));
        assert_eq!(parse_name("fuse-12-manual.db"), Some((12, "manual")));
        assert_eq!(
            parse_name("fuse-12-before-restore.db"),
            Some((12, "before_restore"))
        );
        assert_eq!(parse_name("fuse-12.db-wal"), None);
        assert_eq!(parse_name("fuse-../x.db"), None);
        assert_eq!(parse_name("fuse-12-other.db"), None);
        assert_eq!(parse_name("other.db"), None);
    }

    #[tokio::test]
    async fn backup_now_then_restore_brings_the_data_back() {
        let dir = temp_dir("roundtrip");
        let store = MemoryStore::default();
        let pool = ready(open(&dir, &store).await.unwrap());
        add_thread(&pool, "t1", "Before").await;
        let info = backup_now(&dir, &pool).await.unwrap();
        assert_eq!(info.reason, "manual");
        assert!(!is_plaintext(&dir.join(BACKUPS_DIR).join(&info.name)));
        add_thread(&pool, "t2", "After").await;
        assert_eq!(titles(&pool).await, vec!["After", "Before"]);
        pool.close().await;

        assert!(request_restore(&dir, "fuse-1-manual.db").is_err());
        assert!(request_restore(&dir, "../fuse.db").is_err());
        request_restore(&dir, &info.name).unwrap();
        let pool = ready(open(&dir, &store).await.unwrap());
        assert_eq!(titles(&pool).await, vec!["Before"]);
        pool.close().await;
        assert!(!dir.join(RESTORE_MARKER).exists());

        // The database it replaced was kept, so the restore can be undone.
        let kept = list(&dir)
            .into_iter()
            .find(|b| b.reason == "before_restore")
            .expect("replaced database kept");
        request_restore(&dir, &kept.name).unwrap();
        let pool = ready(open(&dir, &store).await.unwrap());
        assert_eq!(titles(&pool).await, vec!["After", "Before"]);
        pool.close().await;
    }

    #[test]
    fn a_missing_backup_is_not_restored_twice() {
        let dir = temp_dir("missing");
        fs::write(dir.join(DB_FILE), b"current").unwrap();
        fs::write(dir.join(RESTORE_MARKER), "fuse-5-manual.db").unwrap();
        assert!(apply_pending_restore(&dir).is_err());
        assert!(!dir.join(RESTORE_MARKER).exists());
        assert_eq!(fs::read(dir.join(DB_FILE)).unwrap(), b"current");
        assert_eq!(apply_pending_restore(&dir).unwrap(), None);
    }

    #[test]
    fn file_check_finds_missing_and_changed_files() {
        let root = temp_dir("files");
        fs::create_dir_all(root.join("files")).unwrap();
        let hash = |b: &[u8]| -> String {
            Sha256::digest(b)
                .iter()
                .map(|x| format!("{x:02x}"))
                .collect()
        };
        let good = hash(b"good");
        let bad = hash(b"original");
        let gone = hash(b"gone");
        fs::write(root.join("files").join(&good), b"good").unwrap();
        fs::write(root.join("files").join(&bad), b"tampered").unwrap();
        let out = check_files(
            &root,
            &[good.clone(), bad.clone(), gone.clone(), good.clone()],
        );
        assert_eq!(
            out,
            FileCheck {
                checked: 3,
                missing: vec![gone],
                changed: vec![bad],
            }
        );
    }
}
