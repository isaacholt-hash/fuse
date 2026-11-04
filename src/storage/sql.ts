/** Minimal SQL surface the storage layer needs. Implemented by the Tauri SQL plugin in the app
 * and by node:sqlite in tests, so repositories never import Tauri directly. */
export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface SqlDb {
  execute(sql: string, params?: SqlValue[]): Promise<{ rowsAffected: number }>;
  select<Row>(sql: string, params?: SqlValue[]): Promise<Row[]>;
  /** All writes commit together or roll back together, on one connection. */
  batch(statements: readonly SqlStatement[]): Promise<{ rowsAffected: number }[]>;
}
