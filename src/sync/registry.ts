/** The portable replication contract, shared with Rust through the same data file.
 * Adding an application table or column requires explicitly classifying it here.
 */
import registry from "../../data/sync.json";

export interface SyncTable {
  columns: string[];
  localColumns: string[];
  key: string[];
  eligible: string;
  ready: string;
  dependencies: string[];
  types: Record<string, string>;
  references: {
    column: string;
    table: string;
    target: string;
    optional: boolean;
    ownership: boolean;
  }[];
}

export const syncRegistry: {
  version: number;
  tables: Record<string, SyncTable>;
  localTables: Record<string, string>;
  internalTables: string[];
} = registry;
