// The desktop's link to FUSE on HULK (M10 step 7, src-tauri/src/hulk.rs). The device token
// stays in Rust; this side only names the server command and its arguments.
import { invoke } from "@/platform/core";
import type { SqlDb, SqlValue } from "@/storage/sql";

export interface HulkStatus {
  address: string | null;
  paired: boolean;
}

export interface HulkApi {
  status(): Promise<HulkStatus>;
  pair(address: string, code: string, name: string): Promise<HulkStatus>;
  unpair(): Promise<HulkStatus>;
  /** One of the few server commands a handover needs (db_open, db_select, db_execute, key_status). */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Uploads bytes to HULK's file store. */
  putFile(bytes: Uint8Array): Promise<{ sha256: string; size: number }>;
}

export const tauriHulkApi: HulkApi = {
  status: () => invoke<HulkStatus>("hulk_status"),
  pair: (address, code, name) => invoke<HulkStatus>("hulk_pair", { address, code, name }),
  unpair: () => invoke<HulkStatus>("hulk_unpair"),
  invoke: <T>(command: string, args: Record<string, unknown> = {}) =>
    invoke<T>("hulk_invoke", { command, args }),
  putFile: (bytes) => invoke("hulk_put_file", bytes, { headers: {} }),
};

/** HULK's database, through the link. */
export function hulkDb(hulk: HulkApi): SqlDb {
  return {
    execute: (sql: string, params: SqlValue[] = []) =>
      hulk.invoke<{ rowsAffected: number }>("db_execute", { sql, params }),
    select: <Row>(sql: string, params: SqlValue[] = []) =>
      hulk.invoke<Row[]>("db_select", { sql, params }),
  };
}

/** The server's own clone of a repository, for a handed-over run (src-tauri/src/clone.rs). */
export const cloneOnServer = (remote: string, branch: string) =>
  invoke<string>("repo_clone", { remote, branch });
