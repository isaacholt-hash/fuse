//! SQLite storage: migrations for the SQL plugin, and a file backup before new migrations run.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri_plugin_sql::{Migration, MigrationKind};

/// Connection string used by both Rust and the frontend (`Database.load`).
/// The plugin resolves it relative to the app config dir.
pub const DB_URL: &str = "sqlite:fuse.db";
const DB_FILE: &str = "fuse.db";
const MIGRATION_MARKER: &str = "fuse.db.migrations";
const BACKUPS_KEPT: usize = 10;

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "files",
            sql: include_str!("../migrations/0002_files.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "web_search",
            sql: include_str!("../migrations/0003_web_search.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

/// Copies the database to `backups/` when this build has migrations the existing file hasn't seen.
/// Runs at startup, before the frontend opens the database (which is when the plugin migrates).
pub fn backup_before_migrations(
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

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fuse-db-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
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
    fn keeps_only_recent_backups() {
        let dir = temp_dir("prune");
        let backups = dir.join("backups");
        fs::create_dir_all(&backups).unwrap();
        for i in 0..15 {
            fs::write(backups.join(format!("fuse-{i:04}.db")), b"x").unwrap();
        }
        prune_backups(&backups).unwrap();
        let left = fs::read_dir(&backups).unwrap().count();
        assert_eq!(left, BACKUPS_KEPT);
        assert!(backups.join("fuse-0014.db").exists());
        assert!(!backups.join("fuse-0000.db").exists());
    }

    #[test]
    fn migrations_are_numbered_from_one_without_gaps() {
        for (i, m) in migrations().iter().enumerate() {
            assert_eq!(m.version, i as i64 + 1);
        }
    }
}
