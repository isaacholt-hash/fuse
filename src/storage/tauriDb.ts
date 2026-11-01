import { invoke } from "@/platform/core";
import type { SqlDb, SqlValue } from "./sql";

/**
 * The encrypted database (src-tauri/src/db.rs, M1 C2). Rust holds the key and the connection;
 * this side only sends SQL and parameters.
 */
type OpenStatus = "ready" | "needs_recovery_key";

/** The database is encrypted and this computer's keychain doesn't have (the right) key. */
export class DbLockedError extends Error {
  constructor() {
    super("The database is locked: enter the recovery key.");
    this.name = "DbLockedError";
  }
}

const tauriDb: SqlDb = {
  async execute(sql, params: SqlValue[] = []) {
    return invoke<{ rowsAffected: number }>("db_execute", { sql, params });
  },
  select<Row>(sql: string, params: SqlValue[] = []) {
    return invoke<Row[]>("db_select", { sql, params });
  },
};

/** Opens (creating, encrypting and migrating as needed). Throws DbLockedError if locked. */
export async function openTauriDb(): Promise<SqlDb> {
  const status = await invoke<OpenStatus>("db_open");
  if (status !== "ready") throw new DbLockedError();
  return tauriDb;
}

/** Tries a recovery key; true if it opened the database (and is now back in the keychain). */
export async function unlockTauriDb(key: string): Promise<boolean> {
  return (await invoke<OpenStatus>("db_recover", { key })) === "ready";
}

/** The recovery key, grouped for copying into a password manager. */
export const tauriRecoveryKey = () => invoke<string>("db_recovery_key");
