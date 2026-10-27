import Database from "@tauri-apps/plugin-sql";
import type { SqlDb } from "./sql";

/** Must match `DB_URL` in src-tauri/src/db.rs; opening it runs pending migrations. */
const DB_URL = "sqlite:fuse.db";

export async function openTauriDb(): Promise<SqlDb> {
  const db = await Database.load(DB_URL);
  return {
    async execute(sql, params = []) {
      const result = await db.execute(sql, params);
      return { rowsAffected: result.rowsAffected };
    },
    select<Row>(sql: string, params: unknown[] = []) {
      return db.select<Row[]>(sql, params);
    },
  };
}
