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

use crate::ctx::Ctx;
use crate::keys::SecretStore;

pub(crate) const DB_FILE: &str = "fuse.db";
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
    MigrationFile {
        version: 19,
        description: "artifacts",
        sql: include_str!("../migrations/0019_artifacts.sql"),
    },
    MigrationFile {
        version: 20,
        description: "project_tier",
        sql: include_str!("../migrations/0020_project_tier.sql"),
    },
    MigrationFile {
        version: 21,
        description: "imports",
        sql: include_str!("../migrations/0021_imports.sql"),
    },
    MigrationFile {
        version: 22,
        description: "thread_organise",
        sql: include_str!("../migrations/0022_thread_organise.sql"),
    },
    MigrationFile {
        version: 23,
        description: "artifact_cdn",
        sql: include_str!("../migrations/0023_artifact_cdn.sql"),
    },
    MigrationFile {
        version: 24,
        description: "thread_stay",
        sql: include_str!("../migrations/0024_thread_stay.sql"),
    },
    MigrationFile {
        version: 25,
        description: "prompts",
        sql: include_str!("../migrations/0025_prompts.sql"),
    },
    MigrationFile {
        version: 26,
        description: "typed_memory",
        sql: include_str!("../migrations/0026_typed_memory.sql"),
    },
    MigrationFile {
        version: 27,
        description: "memory_reasons",
        sql: include_str!("../migrations/0027_memory_reasons.sql"),
    },
    MigrationFile {
        version: 28,
        description: "egress",
        sql: include_str!("../migrations/0028_egress.sql"),
    },
    MigrationFile {
        version: 29,
        description: "repo",
        sql: include_str!("../migrations/0029_repo.sql"),
    },
    MigrationFile {
        version: 30,
        description: "runs",
        sql: include_str!("../migrations/0030_runs.sql"),
    },
    MigrationFile {
        version: 31,
        description: "run_changes",
        sql: include_str!("../migrations/0031_run_changes.sql"),
    },
    MigrationFile {
        version: 32,
        description: "permissions",
        sql: include_str!("../migrations/0032_permissions.sql"),
    },
    MigrationFile {
        version: 33,
        description: "run_summary",
        sql: include_str!("../migrations/0033_run_summary.sql"),
    },
    MigrationFile {
        version: 34,
        description: "run_branch",
        sql: include_str!("../migrations/0034_run_branch.sql"),
    },
    MigrationFile {
        version: 35,
        description: "run_plan",
        sql: include_str!("../migrations/0035_run_plan.sql"),
    },
    MigrationFile {
        version: 36,
        description: "project_no_model",
        sql: include_str!("../migrations/0036_project_no_model.sql"),
    },
    MigrationFile {
        version: 37,
        description: "local_shadow",
        sql: include_str!("../migrations/0037_local_shadow.sql"),
    },
    MigrationFile {
        version: 38,
        description: "chunks_fts",
        sql: include_str!("../migrations/0038_chunks_fts.sql"),
    },
    MigrationFile {
        version: 39,
        description: "response_cache",
        sql: include_str!("../migrations/0039_response_cache.sql"),
    },
    MigrationFile {
        version: 40,
        description: "folders",
        sql: include_str!("../migrations/0040_folders.sql"),
    },
    MigrationFile {
        version: 41,
        description: "run_folders",
        sql: include_str!("../migrations/0041_run_folders.sql"),
    },
    MigrationFile {
        version: 42,
        description: "step_images",
        sql: include_str!("../migrations/0042_step_images.sql"),
    },
    MigrationFile {
        version: 43,
        description: "change_bytes",
        sql: include_str!("../migrations/0043_change_bytes.sql"),
    },
    MigrationFile {
        version: 44,
        description: "change_batch",
        sql: include_str!("../migrations/0044_change_batch.sql"),
    },
    MigrationFile {
        version: 45,
        description: "network_grants",
        sql: include_str!("../migrations/0045_network_grants.sql"),
    },
    MigrationFile {
        version: 46,
        description: "folder_files",
        sql: include_str!("../migrations/0046_folder_files.sql"),
    },
    MigrationFile {
        version: 47,
        description: "project_tools_off",
        sql: include_str!("../migrations/0047_project_tools_off.sql"),
    },
    MigrationFile {
        version: 48,
        description: "step_flags",
        sql: include_str!("../migrations/0048_step_flags.sql"),
    },
    MigrationFile {
        version: 49,
        description: "mcp_servers",
        sql: include_str!("../migrations/0049_mcp_servers.sql"),
    },
    MigrationFile {
        version: 50,
        description: "run_queue",
        sql: include_str!("../migrations/0050_run_queue.sql"),
    },
    MigrationFile {
        version: 51,
        description: "schedules",
        sql: include_str!("../migrations/0051_schedules.sql"),
    },
    MigrationFile {
        version: 52,
        description: "run_limits",
        sql: include_str!("../migrations/0052_run_limits.sql"),
    },
    MigrationFile {
        version: 53,
        description: "thread_kind",
        sql: include_str!("../migrations/0053_thread_kind.sql"),
    },
    MigrationFile {
        version: 54,
        description: "request_surface",
        sql: include_str!("../migrations/0054_request_surface.sql"),
    },
];

/// Built exactly as tauri-plugin-sql built them (ReversibleUp, in a transaction), so the
/// checksums recorded by earlier versions of FUSE still match.
fn migrator() -> Migrator {
    migrator_until(i64::MAX)
}

/// The migrations up to and including `last` (tests upgrade old databases with it).
fn migrator_until(last: i64) -> Migrator {
    let migrations = MIGRATIONS
        .iter()
        .filter(|m| m.version <= last)
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

pub(crate) fn is_plaintext(path: &Path) -> bool {
    fs::read(path)
        .map(|bytes| bytes.starts_with(PLAINTEXT_HEADER))
        .unwrap_or(false)
}

/// Opens (creating or encrypting first if needed) and migrates the database in `dir`.
pub async fn open(dir: &Path, store: &dyn SecretStore) -> Result<Opened, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the data folder: {e}"))?;
    // A restore asked for in Settings (PL-11) is applied before anything opens the file.
    if let Err(e) = crate::backup::apply_pending_restore(dir) {
        eprintln!("{e}");
    }
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
    migrate(&path, &key, migrator()).await?;
    Ok(Opened::Ready(pool))
}

/// Runs the migrations on a connection of their own with foreign keys off, so a migration can
/// rebuild a table other tables point at (SQLite's documented way; the pragma is ignored inside
/// sqlx's per-migration transaction). Every foreign key is checked afterwards.
async fn migrate(path: &Path, key: &str, migrator: Migrator) -> Result<(), String> {
    let fail = |e: String| format!("Couldn't update the database: {e}");
    let conn = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options(path, Some(key)).foreign_keys(false))
        .await
        .map_err(|e| fail(e.to_string()))?;
    let ran = migrator.run(&conn).await.map_err(|e| fail(e.to_string()));
    let broken = match ran {
        Ok(()) => sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&conn)
            .await
            .map(|rows| rows.len())
            .map_err(|e| fail(e.to_string())),
        Err(e) => Err(e),
    };
    conn.close().await;
    match broken? {
        0 => Ok(()),
        n => Err(fail(format!(
            "{n} rows point at records that no longer exist; restore the backup made before the update"
        ))),
    }
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
    pub(crate) fn pool(&self) -> Result<SqlitePool, String> {
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

// The commands' bodies (M10 step 2). The database lives in the config folder, the one the SQL
// plugin used, so existing databases are found; its key is in the same store as the API keys
// (the OS keychain on the desktop).

pub(crate) async fn db_open(ctx: &Ctx) -> Result<OpenStatus, String> {
    let db = &ctx.db;
    let _one_at_a_time = db.opening.lock().await;
    if db.pool().is_ok() {
        return Ok(OpenStatus::Ready);
    }
    db.settle(open(&ctx.config_dir, ctx.keys.store.as_ref()).await?)
}

pub(crate) async fn db_recover(ctx: &Ctx, key: String) -> Result<OpenStatus, String> {
    let db = &ctx.db;
    let _one_at_a_time = db.opening.lock().await;
    db.settle(recover(&ctx.config_dir, ctx.keys.store.as_ref(), &key).await?)
}

pub(crate) fn db_recovery_key(ctx: &Ctx) -> Result<String, String> {
    recovery_key(ctx.keys.store.as_ref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    rows_affected: u64,
}

pub(crate) async fn db_execute(
    ctx: &Ctx,
    sql: String,
    params: Vec<Value>,
) -> Result<ExecuteResult, String> {
    let rows_affected = execute(&ctx.db.pool()?, &sql, &params).await?;
    Ok(ExecuteResult { rows_affected })
}

pub(crate) async fn db_select(
    ctx: &Ctx,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    select(&ctx.db.pool()?, &sql, &params).await
}

pub mod commands {
    use super::*;
    use tauri::State;

    #[tauri::command]
    pub async fn db_open(ctx: State<'_, Ctx>) -> Result<OpenStatus, String> {
        super::db_open(&ctx).await
    }

    #[tauri::command]
    pub async fn db_recover(ctx: State<'_, Ctx>, key: String) -> Result<OpenStatus, String> {
        super::db_recover(&ctx, key).await
    }

    #[tauri::command]
    pub fn db_recovery_key(ctx: State<'_, Ctx>) -> Result<String, String> {
        super::db_recovery_key(&ctx)
    }

    #[tauri::command]
    pub async fn db_execute(
        ctx: State<'_, Ctx>,
        sql: String,
        params: Vec<Value>,
    ) -> Result<ExecuteResult, String> {
        super::db_execute(&ctx, sql, params).await
    }

    #[tauri::command]
    pub async fn db_select(
        ctx: State<'_, Ctx>,
        sql: String,
        params: Vec<Value>,
    ) -> Result<Vec<Map<String, Value>>, String> {
        super::db_select(&ctx, sql, params).await
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

pub(crate) fn prune_backups(backups: &Path) -> std::io::Result<()> {
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

    /// The last migration shipped before M5. Upgrades from it are checked on seeded data.
    const SEEDED_FROM: i64 = 25;

    /// Rows in the tables later migrations rebuild or extend (memories and what points at it).
    const SEED: &str = "
        INSERT INTO threads (id, workspace_id, user_id, title, created_at, updated_at)
          SELECT 't1', workspace_id, id, 'Seeded chat', 1, 1 FROM users LIMIT 1;
        INSERT INTO messages (id, workspace_id, user_id, thread_id, role, content, created_at, updated_at)
          SELECT 'm1', workspace_id, user_id, 't1', 'user', 'hello', 2, 2 FROM threads WHERE id = 't1';
        INSERT INTO projects (id, workspace_id, user_id, name, created_at, updated_at)
          SELECT 'p1', workspace_id, user_id, 'Seeded project', 3, 3 FROM threads WHERE id = 't1';
        INSERT INTO request_log (id, workspace_id, user_id, thread_id, message_id, purpose, provider,
                                 model, cost_micro_usd, created_at, updated_at)
          SELECT 'r1', workspace_id, user_id, 't1', 'm2', 'chat', 'anthropic', 'claude-haiku-5-5',
                 1234, 3, 3 FROM threads WHERE id = 't1';
        INSERT INTO messages (id, workspace_id, user_id, thread_id, role, content, request_id,
                              created_at, updated_at)
          SELECT 'm2', workspace_id, user_id, 't1', 'assistant', 'hi', 'r1', 3, 3
          FROM threads WHERE id = 't1';
        INSERT INTO memories (id, workspace_id, user_id, text, category, scope, project_id,
                              source_thread_id, confidence, created_at, updated_at)
          SELECT 'mem-new', workspace_id, user_id, 'Prefers metric units', 'preference', 'global',
                 NULL, 't1', 80, 4, 4 FROM threads WHERE id = 't1';
        INSERT INTO memories (id, workspace_id, user_id, text, category, scope, project_id,
                              source_thread_id, confidence, superseded_by_id, created_at, updated_at)
          SELECT 'mem-old', workspace_id, user_id, 'Prefers imperial units', 'preference', 'global',
                 NULL, NULL, 100, 'mem-new', 1, 4 FROM threads WHERE id = 't1';
        INSERT INTO memories (id, workspace_id, user_id, text, category, scope, project_id,
                              confidence, created_at, updated_at, deleted_at)
          SELECT 'mem-proj', workspace_id, user_id, 'Ships on Fridays', 'project', 'project',
                 'p1', 100, 5, 5, NULL FROM threads WHERE id = 't1';
        INSERT INTO memories (id, workspace_id, user_id, text, category, scope, confidence,
                              created_at, updated_at, deleted_at)
          SELECT 'mem-del', workspace_id, user_id, 'Old address', 'fact', 'global', 100, 5, 6, 6
          FROM threads WHERE id = 't1';
        INSERT INTO memory_proposals (id, workspace_id, user_id, op, memory_id, text, category,
                                      status, created_at, updated_at)
          SELECT 'prop1', workspace_id, user_id, 'update', 'mem-new', 'Prefers SI units',
                 'preference', 'pending', 7, 7 FROM threads WHERE id = 't1';
        INSERT INTO message_memories (message_id, memory_id, workspace_id, user_id, created_at)
          SELECT 'm1', 'mem-new', workspace_id, user_id, 8 FROM threads WHERE id = 't1';
        INSERT INTO chunks (id, workspace_id, user_id, source_kind, source_id, ordinal, text,
                            tokens, created_at, updated_at)
          SELECT 'c1', workspace_id, user_id, 'memory', 'mem-new', 0, 'Prefers metric units', 4,
                 9, 9 FROM threads WHERE id = 't1';
    ";

    /// An encrypted database left at `SEEDED_FROM` with `SEED` in it, as an older FUSE made it.
    async fn seeded_old_db(dir: &Path, store: &MemoryStore) {
        let key = new_key().unwrap();
        store.set(KEY_ACCOUNT, &key).unwrap();
        let pool = connect(&dir.join(DB_FILE), Some(&key)).await.unwrap();
        migrator_until(SEEDED_FROM).run(&pool).await.unwrap();
        sqlx::raw_sql(SEED).execute(&pool).await.unwrap();
        pool.close().await;
        fs::write(dir.join(MIGRATION_MARKER), SEEDED_FROM.to_string()).unwrap();
    }

    #[tokio::test]
    async fn upgrading_a_seeded_database_keeps_every_row() {
        let dir = temp_dir("seeded");
        let store = MemoryStore::default();
        seeded_old_db(&dir, &store).await;
        let key = store.get(KEY_ACCOUNT).unwrap().unwrap();
        let old = connect(&dir.join(DB_FILE), Some(&key)).await.unwrap();
        let before = table_counts(&old).await.unwrap();
        old.close().await;

        let pool = ready(open(&dir, &store).await.unwrap());
        let after: std::collections::HashMap<_, _> =
            table_counts(&pool).await.unwrap().into_iter().collect();
        for (table, n) in &before {
            if table == "_sqlx_migrations" {
                continue;
            }
            assert_eq!(after.get(table), Some(n), "rows in {table}");
        }
        let broken: Vec<SqliteRow> = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(broken.is_empty(), "foreign keys still hold");
        // 0026: old memories carried over as typed records (PM-12 to PM-14).
        let rows = select(
            &pool,
            "SELECT id, kind, scope, authority, extraction_method, status FROM memories ORDER BY id",
            &[],
        )
        .await
        .unwrap();
        let got: Vec<String> = rows
            .iter()
            .map(|r| {
                [
                    "id",
                    "kind",
                    "scope",
                    "authority",
                    "extraction_method",
                    "status",
                ]
                .map(|k| r[k].as_str().unwrap_or("").to_string())
                .join(" ")
            })
            .collect();
        assert_eq!(
            got,
            vec![
                "mem-del fact global you typed deleted",
                "mem-new preference global extracted chat active",
                "mem-old preference global you typed superseded",
                "mem-proj fact project you typed active",
            ]
        );
        let proposal = select(&pool, "SELECT kind, origin FROM memory_proposals", &[])
            .await
            .unwrap();
        assert_eq!(proposal[0]["kind"], "preference");
        assert_eq!(proposal[0]["origin"], "import");
        // 0030: request_log rebuilt for the 'agent' purpose; the answer still points at its row.
        let logged = select(
            &pool,
            "SELECT r.cost_micro_usd, r.purpose FROM messages m JOIN request_log r ON r.id = m.request_id WHERE m.id = 'm2'",
            &[],
        )
        .await
        .unwrap();
        assert_eq!(logged[0]["cost_micro_usd"], 1234);
        assert_eq!(logged[0]["purpose"], "chat");
        // 0054: requests written before it say nothing about where they came from.
        let surface = select(&pool, "SELECT surface FROM request_log LIMIT 1", &[])
            .await
            .unwrap();
        assert!(surface[0]["surface"].is_null());
        // 0053: the seeded chat held no run, so it stays in the Chat area.
        let kind = select(&pool, "SELECT kind FROM threads WHERE id = 't1'", &[])
            .await
            .unwrap();
        assert_eq!(kind[0]["kind"], "chat");
        // 0052: an old project has no run limits of its own, so its runs use FUSE's defaults.
        let limits = select(
            &pool,
            "SELECT run_cap_micro_usd, run_wall_minutes, run_idle_minutes FROM projects WHERE id = 'p1'",
            &[],
        )
        .await
        .unwrap();
        assert!(limits[0]["run_cap_micro_usd"].is_null());
        assert!(limits[0]["run_wall_minutes"].is_null());
        assert!(limits[0]["run_idle_minutes"].is_null());
        pool.close().await;
        if (MIGRATIONS.len() as i64) > SEEDED_FROM {
            assert!(
                crate::backup::list(&dir)
                    .iter()
                    .any(|b| b.reason == "update"),
                "backed up before migrating"
            );
        }
    }

    #[tokio::test]
    async fn linked_repositories_become_project_folders_in_0040() {
        let dir = temp_dir("folders40");
        let store = MemoryStore::default();
        let key = new_key().unwrap();
        store.set(KEY_ACCOUNT, &key).unwrap();
        let pool = connect(&dir.join(DB_FILE), Some(&key)).await.unwrap();
        migrator_until(39).run(&pool).await.unwrap();
        // Two projects sharing one folder, one with its own, one with none, one deleted.
        sqlx::raw_sql(
            "INSERT INTO projects (id, workspace_id, user_id, name, repo_root, repo_read_sensitive,
                                   created_at, updated_at)
               SELECT 'p1', workspace_id, id, 'A', '/code/app', 1, 1, 1 FROM users LIMIT 1;
             INSERT INTO projects (id, workspace_id, user_id, name, repo_root, created_at, updated_at)
               SELECT 'p2', workspace_id, id, 'B', '/code/app', 2, 2 FROM users LIMIT 1;
             INSERT INTO projects (id, workspace_id, user_id, name, repo_root, created_at, updated_at)
               SELECT 'p3', workspace_id, id, 'C', '/docs', 3, 3 FROM users LIMIT 1;
             INSERT INTO projects (id, workspace_id, user_id, name, created_at, updated_at)
               SELECT 'p4', workspace_id, id, 'D', 4, 4 FROM users LIMIT 1;
             INSERT INTO projects (id, workspace_id, user_id, name, repo_root, created_at, updated_at,
                                   deleted_at)
               SELECT 'p5', workspace_id, id, 'E', '/gone', 5, 5, 5 FROM users LIMIT 1;",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        fs::write(dir.join(MIGRATION_MARKER), "39").unwrap();
        let pool = ready(open(&dir, &store).await.unwrap());
        let folders = select(
            &pool,
            "SELECT path, read_sensitive FROM folders ORDER BY path",
            &[],
        )
        .await
        .unwrap();
        let got: Vec<String> = folders
            .iter()
            .map(|r| format!("{} {}", r["path"].as_str().unwrap(), r["read_sensitive"]))
            .collect();
        assert_eq!(got, vec!["/code/app 1", "/docs 0"]);
        let links = select(
            &pool,
            "SELECT pf.project_id, f.path FROM project_folders pf JOIN folders f ON f.id = pf.folder_id
             ORDER BY pf.project_id",
            &[],
        )
        .await
        .unwrap();
        let got: Vec<String> = links
            .iter()
            .map(|r| {
                format!(
                    "{} {}",
                    r["project_id"].as_str().unwrap(),
                    r["path"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(got, vec!["p1 /code/app", "p2 /code/app", "p3 /docs"]);
        pool.close().await;
    }

    #[tokio::test]
    async fn threads_take_the_kind_of_their_last_run_in_0053() {
        let dir = temp_dir("kind53");
        let store = MemoryStore::default();
        let key = new_key().unwrap();
        store.set(KEY_ACCOUNT, &key).unwrap();
        let pool = connect(&dir.join(DB_FILE), Some(&key)).await.unwrap();
        migrator_until(52).run(&pool).await.unwrap();
        // A chat with no run, one with a Code run, one with a Code run then a Work run.
        sqlx::raw_sql(
            "INSERT INTO threads (id, workspace_id, user_id, title, created_at, updated_at)
               SELECT 't-none', workspace_id, id, 'A', 1, 1 FROM users LIMIT 1;
             INSERT INTO threads (id, workspace_id, user_id, title, created_at, updated_at)
               SELECT 't-code', workspace_id, id, 'B', 2, 2 FROM users LIMIT 1;
             INSERT INTO threads (id, workspace_id, user_id, title, created_at, updated_at)
               SELECT 't-mixed', workspace_id, id, 'C', 3, 3 FROM users LIMIT 1;
             INSERT INTO runs (id, workspace_id, user_id, thread_id, task, kind, mode, provider,
                               model, status, cap_micro_usd, created_at, updated_at)
               SELECT 'r1', workspace_id, id, 't-code', 'x', 'code', 'plan', 'anthropic', 'm',
                      'done', 1, 1, 1 FROM users LIMIT 1;
             INSERT INTO runs (id, workspace_id, user_id, thread_id, task, kind, mode, provider,
                               model, status, cap_micro_usd, created_at, updated_at)
               SELECT 'r2', workspace_id, id, 't-mixed', 'x', 'code', 'plan', 'anthropic', 'm',
                      'done', 1, 1, 1 FROM users LIMIT 1;
             INSERT INTO runs (id, workspace_id, user_id, thread_id, task, kind, mode, provider,
                               model, status, cap_micro_usd, created_at, updated_at)
               SELECT 'r3', workspace_id, id, 't-mixed', 'x', 'work', 'plan', 'anthropic', 'm',
                      'done', 1, 2, 2 FROM users LIMIT 1;",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        fs::write(dir.join(MIGRATION_MARKER), "52").unwrap();
        let pool = ready(open(&dir, &store).await.unwrap());
        let rows = select(&pool, "SELECT id, kind FROM threads ORDER BY id", &[])
            .await
            .unwrap();
        let got: Vec<String> = rows
            .iter()
            .map(|r| {
                format!(
                    "{} {}",
                    r["id"].as_str().unwrap(),
                    r["kind"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(got, vec!["t-code code", "t-mixed work", "t-none chat"]);
        pool.close().await;
    }

    #[tokio::test]
    async fn runs_made_before_0041_keep_their_steps_and_get_their_folder() {
        let dir = temp_dir("runs41");
        let store = MemoryStore::default();
        let key = new_key().unwrap();
        store.set(KEY_ACCOUNT, &key).unwrap();
        let pool = connect(&dir.join(DB_FILE), Some(&key)).await.unwrap();
        migrator_until(40).run(&pool).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO projects (id, workspace_id, user_id, name, created_at, updated_at)
               SELECT 'p1', workspace_id, id, 'P', 1, 1 FROM users LIMIT 1;
             INSERT INTO folders (id, workspace_id, user_id, path, created_at, updated_at)
               SELECT 'f1', workspace_id, id, '/code/app', 1, 1 FROM users LIMIT 1;
             INSERT INTO project_folders (id, workspace_id, user_id, project_id, folder_id, created_at)
               SELECT 'pf1', workspace_id, id, 'p1', 'f1', 1 FROM users LIMIT 1;
             INSERT INTO runs (id, workspace_id, user_id, project_id, task, mode, provider, model,
                               status, cap_micro_usd, branch, plan, created_at, updated_at)
               SELECT 'r1', workspace_id, id, 'p1', 'Fix it', 'ask', 'anthropic', 'm', 'done',
                      1000000, 'fuse/fix-it', 'Look first', 2, 2 FROM users LIMIT 1;
             INSERT INTO run_steps (id, workspace_id, user_id, run_id, seq, kind, text, created_at,
                                    updated_at)
               SELECT 's1', workspace_id, id, 'r1', 0, 'model', 'Done.', 3, 3 FROM users LIMIT 1;",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        fs::write(dir.join(MIGRATION_MARKER), "40").unwrap();
        let pool = ready(open(&dir, &store).await.unwrap());
        let run = select(
            &pool,
            "SELECT kind, mode, branch, plan, project_id FROM runs",
            &[],
        )
        .await
        .unwrap();
        assert_eq!(run[0]["kind"], "code");
        assert_eq!(run[0]["mode"], "ask");
        assert_eq!(run[0]["branch"], "fuse/fix-it");
        assert_eq!(run[0]["plan"], "Look first");
        let steps = select(&pool, "SELECT run_id FROM run_steps", &[])
            .await
            .unwrap();
        assert_eq!(steps.len(), 1);
        let folders = select(&pool, "SELECT folder_id, label FROM run_folders", &[])
            .await
            .unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0]["folder_id"], "f1");
        let broken: Vec<SqliteRow> = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(broken.is_empty(), "foreign keys still hold");
        pool.close().await;
    }

    #[tokio::test]
    async fn runs_made_before_0031_keep_their_steps() {
        let dir = temp_dir("runs31");
        let store = MemoryStore::default();
        let key = new_key().unwrap();
        store.set(KEY_ACCOUNT, &key).unwrap();
        let pool = connect(&dir.join(DB_FILE), Some(&key)).await.unwrap();
        migrator_until(30).run(&pool).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO projects (id, workspace_id, user_id, name, created_at, updated_at)
               SELECT 'p1', workspace_id, id, 'P', 1, 1 FROM users LIMIT 1;
             INSERT INTO runs (id, workspace_id, user_id, project_id, task, provider, model, status,
                               cap_micro_usd, spent_micro_usd, created_at, updated_at)
               SELECT 'run1', workspace_id, user_id, 'p1', 'Look', 'anthropic', 'm', 'done',
                      1000000, 1234, 2, 2 FROM projects WHERE id = 'p1';
             INSERT INTO run_steps (id, workspace_id, user_id, run_id, seq, kind, text, created_at,
                                    updated_at)
               SELECT 's1', workspace_id, user_id, 'run1', 1, 'model', 'Found it.', 3, 3
               FROM projects WHERE id = 'p1';",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        fs::write(dir.join(MIGRATION_MARKER), "30").unwrap();

        let pool = ready(open(&dir, &store).await.unwrap());
        let rows = select(
            &pool,
            "SELECT r.mode, r.spent_micro_usd, s.text FROM runs r JOIN run_steps s ON s.run_id = r.id",
            &[],
        )
        .await
        .unwrap();
        assert_eq!(rows[0]["mode"], "plan");
        assert_eq!(rows[0]["spent_micro_usd"], 1234);
        assert_eq!(rows[0]["text"], "Found it.");
        let broken: Vec<SqliteRow> = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(broken.is_empty(), "foreign keys still hold");
        pool.close().await;
    }

    #[test]
    fn migrations_are_numbered_in_order() {
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert_eq!(m.version, i as i64 + 1);
        }
    }
}
