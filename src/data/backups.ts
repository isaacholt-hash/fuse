import { invoke } from "@tauri-apps/api/core";

/** One copy of the encrypted database in the app's `backups/` folder (PL-11). */
export interface BackupInfo {
  name: string;
  createdMs: number;
  bytes: number;
  /** Made before an update's migrations, on request, or kept when a restore replaced it. */
  reason: "update" | "manual" | "before_restore";
}

/** Attachment files re-hashed against the database: missing or changed ones are listed. */
export interface FileCheck {
  checked: number;
  missing: string[];
  changed: string[];
}

/** Backup and restore (src-tauri/src/backup.rs). */
export interface BackupsApi {
  list(): Promise<BackupInfo[]>;
  backupNow(): Promise<BackupInfo>;
  /** Restores the backup at the next start and restarts the app now. */
  restore(name: string): Promise<void>;
  checkFiles(): Promise<FileCheck>;
}

export const tauriBackupsApi: BackupsApi = {
  list: () => invoke<BackupInfo[]>("backup_list"),
  backupNow: () => invoke<BackupInfo>("backup_now"),
  restore: (name) => invoke("backup_restore", { name }),
  checkFiles: () => invoke<FileCheck>("files_check"),
};

const REASONS: Record<BackupInfo["reason"], string> = {
  update: "before an update",
  manual: "backed up by you",
  before_restore: "replaced by a restore",
};

/** "29 Oct 2026, 10:58 · 1.2 MB · before an update" */
export function describeBackup(b: BackupInfo): string {
  const when = new Date(b.createdMs).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const mb = b.bytes / (1024 * 1024);
  const size =
    mb >= 1 ? `${mb.toFixed(1)} MB` : `${String(Math.max(1, Math.round(b.bytes / 1024)))} KB`;
  return `${when} · ${size} · ${REASONS[b.reason]}`;
}

/** One line for the result of a file check. */
export function describeFileCheck(c: FileCheck): string {
  if (c.missing.length === 0 && c.changed.length === 0) {
    return `All ${String(c.checked)} attached files match.`;
  }
  const parts = [];
  if (c.missing.length) parts.push(`${String(c.missing.length)} missing`);
  if (c.changed.length) parts.push(`${String(c.changed.length)} changed`);
  return `Checked ${String(c.checked)} attached files: ${parts.join(", ")}.`;
}
