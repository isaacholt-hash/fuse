/** Minimal SQL surface the storage layer needs. Implemented by the Tauri SQL plugin in the app
 * and by node:sqlite in tests, so repositories never import Tauri directly. */
export type SqlValue = string | number | null;

export interface SqlDb {
  execute(sql: string, params?: SqlValue[]): Promise<{ rowsAffected: number }>;
  select<Row>(sql: string, params?: SqlValue[]): Promise<Row[]>;
}
