// Test-only SqlDb on node:sqlite, with the real migrations from src-tauri/migrations applied.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDb, SqlValue } from "../sql";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../../src-tauri/migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export function openTestDb(): SqlDb & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  // As in db.rs `migrate`: migrations run with foreign keys off, then every key is checked.
  for (const file of migrationFiles()) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  if (raw.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("A migration left rows pointing at missing records.");
  }
  raw.exec("PRAGMA foreign_keys = ON;"); // the app's connections enforce them too
  return {
    raw,
    execute(sql: string, params: SqlValue[] = []) {
      const result = raw.prepare(sql).run(...params);
      return Promise.resolve({ rowsAffected: Number(result.changes) });
    },
    select<Row>(sql: string, params: SqlValue[] = []) {
      return Promise.resolve(raw.prepare(sql).all(...params) as Row[]);
    },
  };
}
