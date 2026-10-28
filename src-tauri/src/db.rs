//! The local database: SQLite encrypted with SQLCipher (M1 C2, PL-03).
//!
//! The key is 32 random bytes kept in the OS keychain next to the API keys, so there's no
//! password to type. The frontend never sees it, except as the recovery key Isaac can show in
//! Settings and type back in if the keychain entry is ever lost. An existing unencrypted
//! database is encrypted in place on first launch. Migrations are the same sqlx migrations the
//! SQL plugin ran before, so `_sqlx_migrations` carries over unchanged.

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Row, TypeInfo, ValueRef};

use crate::keys::SecretStore;

const DB_FILE: &str = "fuse.db";
const MIGRATION_MARKER: &str = "fuse.db.migrations";
const BACKUPS_KEPT: usize = 10;
/// Keychain account holding the database key (hex), beside the provider keys.
const KEY_ACCOUNT: &str = "database-key";
const PLAINTEXT_HEADER: &[u8; 16] = b"SQLite format 3\0";

struct MigrationFile {
    version: i64,
    description: &'static str,
    sql: &'static str,
}

/// Versioned migrations, oldest first. Never edit a shipped one.
const MIGRATIONS: &[MigrationFile] = &[
    MigrationFile {
        version: 1,
        description: "init",
        sql: include_str!("../migrations/0001_init.sql"),
    },
    MigrationFile {
        version: 2,
        description: "files",
        sql: include_str!("../migrations/0002_files.sql"),
    },
    MigrationFile {
        version: 3,
        description: "web_search",
        sql: include_str!("../migrations/0003_web_search.sql"),
    },
    MigrationFile {
        version: 4,
        description: "instructions",
        sql: include_str!("../migrations/0004_instructions.sql"),
    },
    MigrationFile {
        version: 5,
        description: "projects",
        sql: include_str!("../migrations/0005_projects.sql"),
    },
    MigrationFile {
        version: 6,
        description: "memory",
        sql: include_str!("../migrations/0006_memory.sql"),
    },
    MigrationFile {
        version: 7,
        description: "golden_prompts",
        sql: include_str!("../migrations/0007_golden_prompts.sql"),
    },
    MigrationFile {
        version: 8,
        description: "routing",
        sql: include_str!("../migrations/0008_routing.sql"),
    },
    MigrationFile {
        version: 9,
        description: "escalation",
        sql: include_str!("../migrations/0009_escalation.sql"),
    },
    MigrationFile {
        version: 10,
        description: "feedback",
        sql: include_str!("../migrations/0010_feedback.sql"),
    },
    MigrationFile {
        version: 11,
        description: "branches",
        sql: include_str!("../migrations/0011_branches.sql"),
    },
    MigrationFile {
        version: 12,
        description: "search",
        sql: include_str!("../migrations/0012_search.sql"),
    },
    MigrationFile {
        version: 13,
        description: "incognito",
        sql: include_str!("../migrations/0013_incognito.sql"),
    },
    MigrationFile {
        version: 14,
        description: "summaries",
        sql: include_str!("../migrations/0014_summaries.sql"),
    },
    MigrationFile {
        version: 15,
        description: "budgets",
        sql: include_str!("../migrations/0015_budgets.sql"),
    },
    MigrationFile {
        version: 16,
        description: "vectors",
        sql: include_str!("../migrations/0016_vectors.sql"),
    },
    MigrationFile {
        version: 17,
        description: "project_files",
        sql: include_str!("../migrations/0017_project_files.sql"),
    },
    MigrationFile {
        version: 18,
        description: "web_pages",
        sql: include_str!("../migrations/0018_web_pages.sql"),
    },
];

/// Built exactly as tauri-plugin-sql built them (ReversibleUp, in a transaction), so the
/// checksums recorded by earlier versions of FUSE still match.
fn migrator() -> Migrator {
    let migrations = MIGRATIONS
        .iter()
        .map(|m| {
            SqlxMigration::new(
                m.version,
                Cow::Borrowed(m.description),
                MigrationType::ReversibleUp,
                Cow::Borrowed(m.sql),
                false,
            )
        })
        .collect::<Vec<_>>();
    Migrator {
        migrations: Cow::Owned(migrations),
        ..Migrator::DEFAULT
    }
}

// ---------------------------------------------------------------------------------------------
// Keys

fn new_key() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Couldn't make a database key: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Accepts the recovery key as shown (groups and dashes) or bare; returns 64 lowercase hex.
pub fn parse_recovery_key(input: &str) -> Option<String> {
    let hex: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>()
        .to_lowercase();
    (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())).then_some(hex)
}

/// The key as Isaac sees it: 8 groups of 8, easy to copy into a password manager.
pub fn format_recovery_key(hex: &str) -> String {
    hex.as_bytes()
        .chunks(8)
        .map(|c| String::from_utf8_lossy(c).to_uppercase())
        .collect::<Vec<_>>()
        .join("-")
}

// ---------------------------------------------------------------------------------------------
// Opening

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenStatus {
    Ready,
    /// The database is encrypted but the keychain has no key, or the wrong one.
    NeedsRecoveryKey,
}

pub enum Opened {
    Ready(SqlitePool),
    NeedsRecoveryKey,
}

fn options(path: &Path, key: Option<&str>) -> SqliteConnectOptions {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    match key {
        // Raw key: no passphrase derivation, since it's already 256 random bits.
        Some(hex) => options.pragma("key", format!("\"x'{hex}'\"")),
        None => options,
    }
}

async fn connect(path: &Path, key: Option<&str>) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .connect_with(options(path, key))
        .await?;
    // The key is only checked on the first read.
    sqlx::query("SELECT count(*) FROM sqlite_master")
        .fetch_one(&pool)
        .await?;
    Ok(pool)
}

fn is_wrong_key(e: &sqlx::Error) -> bool {
    // SQLITE_NOTADB (26): "file is not a database", which is what a wrong key looks like.
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("26"))
}

fn is_plaintext(path: &Path) -> bool {
    fs::read(path)
        .map(|bytes| bytes.starts_with(PLAINTEXT_HEADER))
        .unwrap_or(false)
}

/// Opens (creating or encrypting first if needed) and migrates the database in `dir`.
pub async fn open(dir: &Path, store: &dyn SecretStore) -> Result<Opened, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the data folder: {e}"))?;
    let path = dir.join(DB_FILE);
    let stored = store.get(KEY_ACCOUNT)?;

    let key = match stored {
        Some(key) => key,
        None if path.exists() && !is_plaintext(&path) => return Ok(Opened::NeedsRecoveryKey),
        None => {
            // A new install, or an unencrypted database from before C2: make the key and make
            // sure the keychain really has it before anything is encrypted with it.
            let key = new_key()?;
            store.set(KEY_ACCOUNT, &key)?;
            if store.get(KEY_ACCOUNT)?.as_deref() != Some(key.as_str()) {
                return Err("The OS keychain didn't keep the database key.".into());
            }
            key
        }
    };
    if path.exists() && is_plaintext(&path) {
        encrypt_in_place(dir, &key).await?;
    }

    backup_before_migrations(dir, MIGRATIONS.len())
        .map_err(|e| format!("Couldn't back up the database: {e}"))?;
    let pool = match connect(&path, Some(&key)).await {
        Ok(pool) => pool,
        Err(e) if is_wrong_key(&e) => return Ok(Opened::NeedsRecoveryKey),
        Err(e) => return Err(format!("Couldn't open the database: {e}")),
    };
    migrator()
        .run(&pool)
        .await
        .map_err(|e| format!("Couldn't update the database: {e}"))?;
    Ok(Opened::Ready(pool))
}

/// Tries a recovery key; if it opens the database, it goes back in the keychain.
pub async fn recover(dir: &Path, store: &dyn SecretStore, input: &str) -> Result<Opened, String> {
    let Some(key) = parse_recovery_key(input) else {
        return Ok(Opened::NeedsRecoveryKey);
    };
    match connect(&dir.join(DB_FILE), Some(&key)).await {
        Ok(pool) => pool.close().await,
        Err(e) if is_wrong_key(&e) => return Ok(Opened::NeedsRecoveryKey),
        Err(e) => return Err(format!("Couldn't open the database: {e}")),
    }
    store.set(KEY_ACCOUNT, &key)?;
    open(dir, store).await
}

pub fn recovery_key(store: &dyn SecretStore) -> Result<String, String> {
    store
        .get(KEY_ACCOUNT)?
        .map(|hex| format_recovery_key(&hex))
        .ok_or_else(|| "No database key in the keychain.".into())
}

/// Row counts per table, to check that encryption copied everything.
async fn table_counts(pool: &SqlitePool) -> Result<Vec<(String, i64)>, sqlx::Error> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(pool)
    .await?;
    let mut counts = Vec::new();
    for table in tables {
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM \"{table}\""))
            .fetch_one(pool)
            .await?;
        counts.push((table, n));
    }
    Ok(counts)
}

/// Encrypts an unencrypted database with `sqlcipher_export`, checks the copy, swaps it in, and
/// removes the unencrypted file and any unencrypted backups.
async fn encrypt_in_place(dir: &Path, key: &str) -> Result<(), String> {
    let fail = |e: sqlx::Error| format!("Couldn't encrypt the database: {e}");
    let path = dir.join(DB_FILE);
    let encrypted = dir.join(format!("{DB_FILE}.encrypting"));
    let _ = fs::remove_file(&encrypted);

    let plain = SqlitePoolOptions::new()
        .max_connections(1)
        // "Create" is needed for ATTACH to make the encrypted copy (the file itself exists).
        .connect_with(options(&path, None))
        .await
        .map_err(fail)?;
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&plain)
        .await
        .map_err(fail)?;
    let before = table_counts(&plain).await.map_err(fail)?;
    let target = encrypted.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!(
        "ATTACH DATABASE '{target}' AS encrypted KEY \"x'{key}'\""
    ))
    .execute(&plain)
    .await
    .map_err(fail)?;
    sqlx::query("SELECT sqlcipher_export('encrypted')")
        .execute(&plain)
        .await
        .map_err(fail)?;
    sqlx::query("DETACH DATABASE encrypted")
        .execute(&plain)
        .await
        .map_err(fail)?;
    plain.close().await;

    let copy = connect(&encrypted, Some(key)).await.map_err(fail)?;
    let after = table_counts(&copy).await.map_err(fail)?;
    copy.close().await;
    if before != after || is_plaintext(&encrypted) {
        let _ = fs::remove_file(&encrypted);
        return Err("Encrypting the database didn't copy everything; nothing was changed.".into());
    }

    for ext in ["-wal", "-shm"] {
        let _ = fs::remove_file(dir.join(format!("{DB_FILE}{ext}")));
    }
    fs::rename(&encrypted, &path).map_err(|e| format!("Couldn't swap in the database: {e}"))?;
    remove_plaintext_backups(&dir.join("backups"));
    Ok(())
}

fn remove_plaintext_backups(backups: &Path) {
    let Ok(entries) = fs::read_dir(backups) else {
        return;
    };
    for path in entries.filter_map(|e| e.ok().map(|e| e.path())) {
        if path.extension().is_some_and(|x| x == "db") && is_plaintext(&path) {
            for ext in ["", "-wal", "-shm"] {
                let _ = fs::remove_file(PathBuf::from(format!("{}{ext}", path.display())));
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Queries from the frontend (src/storage/tauriDb.ts)

fn bind<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    params: &'q [Value],
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for p in params {
        query = match p {
            Value::Null => query.bind(None::<String>),
            Value::Bool(b) => query.bind(i64::from(*b)),
            Value::Number(n) => match n.as_i64() {
                Some(i) => query.bind(i),
                None => query.bind(n.as_f64()),
            },
            Value::String(s) => query.bind(s.as_str()),
            other => query.bind(other.to_string()),
        };
    }
    query
}

fn row_to_json(row: &SqliteRow) -> Result<Map<String, Value>, sqlx::Error> {
    let mut out = Map::new();
    for (i, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(i)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            // SQLite is dynamically typed: use the type of this value, not the column's.
            match raw.type_info().name() {
                "INTEGER" => Value::from(row.try_get::<i64, _>(i)?),
                "REAL" => Value::from(row.try_get::<f64, _>(i)?),
                "BLOB" => Value::from(row.try_get::<Vec<u8>, _>(i)?),
                _ => Value::from(row.try_get::<String, _>(i)?),
            }
        };
        out.insert(column.name().to_owned(), value);
    }
    Ok(out)
}

pub async fn execute(pool: &SqlitePool, sql: &str, params: &[Value]) -> Result<u64, String> {
    bind(sqlx::query(sql), params)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .map_err(|e| e.to_string())
}

pub async fn select(
    pool: &SqlitePool,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Map<String, Value>>, String> {
    let rows = bind(sqlx::query(sql), params)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    rows.iter()
        .map(row_to_json)
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())
}

/// The open database, once `db_open` has succeeded.
#[derive(Default)]
pub struct Database {
    pool: Mutex<Option<SqlitePool>>,
    /// Opening runs one at a time: two at once (React runs effects twice in dev) would both try
    /// to encrypt the same file.
    opening: tauri::async_runtime::Mutex<()>,
}

impl Database {
    fn pool(&self) -> Result<SqlitePool, String> {
        self.pool
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "The database isn't open.".into())
    }

    fn settle(&self, opened: Opened) -> Result<OpenStatus, String> {
        match opened {
            Opened::Ready(pool) => {
                *self.pool.lock().map_err(|e| e.to_string())? = Some(pool);
                Ok(OpenStatus::Ready)
            }
            Opened::NeedsRecoveryKey => Ok(OpenStatus::NeedsRecoveryKey),
        }
    }
}

pub mod commands {
    use super::*;
    use crate::keys::OsKeychain;
    use tauri::{AppHandle, Manager, State};

    fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
        // Same folder the SQL plugin used, so existing databases are found.
        app.path().app_config_dir().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn db_open(app: AppHandle, db: State<'_, Database>) -> Result<OpenStatus, String> {
        let _one_at_a_time = db.opening.lock().await;
        if db.pool().is_ok() {
            return Ok(OpenStatus::Ready);
        }
        db.settle(open(&data_dir(&app)?, &OsKeychain).await?)
    }

    #[tauri::command]
    pub async fn db_recover(
        app: AppHandle,
        db: State<'_, Database>,
        key: String,
    ) -> Result<OpenStatus, String> {
        let _one_at_a_time = db.opening.lock().await;
        db.settle(recover(&data_dir(&app)?, &OsKeychain, &key).await?)
    }

    #[tauri::command]
    pub fn db_recovery_key() -> Result<String, String> {
        recovery_key(&OsKeychain)
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ExecuteResult {
        rows_affected: u64,
    }

    #[tauri::command]
    pub async fn db_execute(
        db: State<'_, Database>,
        sql: String,
        params: Vec<Value>,
    ) -> Result<ExecuteResult, String> {
        let rows_affected = execute(&db.pool()?, &sql, &params).await?;
        Ok(ExecuteResult { rows_affected })
    }

    #[tauri::command]
    pub async fn db_select(
        db: State<'_, Database>,
        sql: String,
        params: Vec<Value>,
    ) -> Result<Vec<Map<String, Value>>, String> {
        select(&db.pool()?, &sql, &params).await
    }
}

// ---------------------------------------------------------------------------------------------
// Backups

/// Copies the database to `backups/` when this build has migrations the existing file hasn't seen.
fn backup_before_migrations(
    dir: &Path,
    migration_count: usize,
) -> std::io::Result<Option<PathBuf>> {
    let db = dir.join(DB_FILE);
    let marker = dir.join(MIGRATION_MARKER);
    let recorded: usize = fs::read_to_string(&marker)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    let mut backup = None;
    if db.exists() && recorded < migration_count {
        let backups = dir.join("backups");
        fs::create_dir_all(&backups)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let target = backups.join(format!("fuse-{stamp}.db"));
        fs::copy(&db, &target)?;
        // Uncheckpointed WAL data would be lost without its side files.
        for ext in ["-wal", "-shm"] {
            let side = dir.join(format!("{DB_FILE}{ext}"));
            if side.exists() {
                fs::copy(&side, backups.join(format!("fuse-{stamp}.db{ext}")))?;
            }
        }
        prune_backups(&backups)?;
        backup = Some(target);
    }
    if recorded != migration_count {
        fs::create_dir_all(dir)?;
        fs::write(&marker, migration_count.to_string())?;
    }
    Ok(backup)
}

fn prune_backups(backups: &Path) -> std::io::Result<()> {
    let mut dbs: Vec<PathBuf> = fs::read_dir(backups)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "db"))
        .collect();
    dbs.sort();
    let excess = dbs.len().saturating_sub(BACKUPS_KEPT);
    for old in dbs.into_iter().take(excess) {
        for ext in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(PathBuf::from(format!("{}{ext}", old.display())));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::MemoryStore;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fuse-db-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ready(opened: Opened) -> SqlitePool {
        match opened {
            Opened::Ready(pool) => pool,
            Opened::NeedsRecoveryKey => panic!("expected the database to open"),
        }
    }

    async fn thread_titles(pool: &SqlitePool) -> Vec<Value> {
        select(pool, "SELECT title FROM threads ORDER BY title", &[])
            .await
            .unwrap()
            .into_iter()
            .map(|r| r["title"].clone())
            .collect()
    }

    /// The same migrations run unencrypted, as the SQL plugin did before C2.
    async fn old_plaintext_db(dir: &Path) {
        let pool = SqlitePoolOptions::new()
            .connect_with(options(&dir.join(DB_FILE), None))
            .await
            .unwrap();
        migrator().run(&pool).await.unwrap();
        let (ws, user): (String, String) =
            sqlx::query_as("SELECT workspace_id, id FROM users LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        execute(
            &pool,
            "INSERT INTO threads (id, workspace_id, user_id, title, created_at, updated_at)
             VALUES ('t1', ?, ?, 'Old chat', 1, 1)",
            &[Value::from(ws), Value::from(user)],
        )
        .await
        .unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn new_install_is_encrypted_and_migrated() {
        let dir = temp_dir("new");
        let store = MemoryStore::default();
        let pool = ready(open(&dir, &store).await.unwrap());
        assert!(thread_titles(&pool).await.is_empty());
        pool.close().await;
        assert!(!is_plaintext(&dir.join(DB_FILE)));
        assert_eq!(store.get(KEY_ACCOUNT).unwrap().map(|k| k.len()), Some(64));
        // Without the key it can't be read.
        assert!(is_wrong_key(
            &connect(&dir.join(DB_FILE), None).await.unwrap_err()
        ));
    }

    #[tokio::test]
    async fn existing_unencrypted_database_is_encrypted_in_place() {
        let dir = temp_dir("convert");
        old_plaintext_db(&dir).await;
        fs::create_dir_all(dir.join("backups")).unwrap();
        fs::copy(dir.join(DB_FILE), dir.join("backups/fuse-1.db")).unwrap();
        fs::write(dir.join(MIGRATION_MARKER), MIGRATIONS.len().to_string()).unwrap();

        let store = MemoryStore::default();
        let pool = ready(open(&dir, &store).await.unwrap());
        assert_eq!(thread_titles(&pool).await, vec![Value::from("Old chat")]);
        pool.close().await;
        assert!(!is_plaintext(&dir.join(DB_FILE)));
        assert!(
            !dir.join("backups/fuse-1.db").exists(),
            "plaintext backup removed"
        );
        assert!(!dir.join(format!("{DB_FILE}.encrypting")).exists());

        // Next launch just opens it.
        let pool = ready(open(&dir, &store).await.unwrap());
        assert_eq!(thread_titles(&pool).await.len(), 1);
        pool.close().await;
    }

    #[tokio::test]
    async fn lost_keychain_entry_needs_the_recovery_key() {
        let dir = temp_dir("recover");
        let store = MemoryStore::default();
        ready(open(&dir, &store).await.unwrap()).close().await;
        let shown = recovery_key(&store).unwrap();
        assert_eq!(shown.len(), 64 + 7);

        let fresh = MemoryStore::default(); // e.g. a new PC with the old data folder
        assert!(matches!(
            open(&dir, &fresh).await.unwrap(),
            Opened::NeedsRecoveryKey
        ));
        let wrong = "0".repeat(64);
        assert!(matches!(
            recover(&dir, &fresh, &wrong).await.unwrap(),
            Opened::NeedsRecoveryKey
        ));
        assert!(matches!(
            recover(&dir, &fresh, "not a key").await.unwrap(),
            Opened::NeedsRecoveryKey
        ));
        ready(recover(&dir, &fresh, &shown.to_lowercase()).await.unwrap())
            .close()
            .await;
        assert_eq!(recovery_key(&fresh).unwrap(), shown);
    }

    #[tokio::test]
    async fn values_round_trip_with_their_types() {
        let dir = temp_dir("types");
        let pool = ready(open(&dir, &MemoryStore::default()).await.unwrap());
        execute(
            &pool,
            "CREATE TABLE t (i INTEGER, r REAL, s TEXT, n TEXT)",
            &[],
        )
        .await
        .unwrap();
        let n = execute(
            &pool,
            "INSERT INTO t VALUES (?, ?, ?, ?)",
            &[
                Value::from(42),
                Value::from(1.5),
                Value::from("hé"),
                Value::Null,
            ],
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let rows = select(&pool, "SELECT * FROM t", &[]).await.unwrap();
        assert_eq!(
            Value::Object(rows[0].clone()),
            serde_json::json!({ "i": 42, "r": 1.5, "s": "hé", "n": null })
        );
        pool.close().await;
    }

    #[test]
    fn recovery_key_format_round_trips() {
        let hex = "0123456789abcdef".repeat(4);
        let shown = format_recovery_key(&hex);
        assert_eq!(&shown[..17], "01234567-89ABCDEF");
        assert_eq!(parse_recovery_key(&shown).as_deref(), Some(hex.as_str()));
        assert_eq!(parse_recovery_key(" 0123 "), None);
    }

    #[test]
    fn fresh_install_writes_marker_without_backup() {
        let dir = temp_dir("fresh");
        assert_eq!(backup_before_migrations(&dir, 1).unwrap(), None);
        assert_eq!(fs::read_to_string(dir.join(MIGRATION_MARKER)).unwrap(), "1");
        assert!(!dir.join("backups").exists());
    }

    #[test]
    fn new_migration_backs_up_once() {
        let dir = temp_dir("upgrade");
        fs::write(dir.join(DB_FILE), b"db").unwrap();
        fs::write(dir.join("fuse.db-wal"), b"wal").unwrap();
        fs::write(dir.join(MIGRATION_MARKER), "1").unwrap();

        let backup = backup_before_migrations(&dir, 2)
            .unwrap()
            .expect("backup made");
        assert_eq!(fs::read(&backup).unwrap(), b"db");
        assert!(PathBuf::from(format!("{}-wal", backup.display())).exists());
        // Second start with the same build: nothing new to back up.
        assert_eq!(backup_before_migrations(&dir, 2).unwrap(), None);
    }

    #[test]
    fn migrations_are_numbered_in_order() {
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert_eq!(m.version, i as i64 + 1);
        }
    }
}
