// M10 step 19 (PL-11): the first start after an update checks the database and the attached
// files, and says so only when something is wrong. The build (commit and schema) is remembered
// in settings; a release without new migrations still counts as an update.
import { invoke } from "@/platform/core";
import type { Tenant } from "@/storage/defaults";
import { getSetting, setSetting } from "@/storage/settings";
import type { SqlDb } from "@/storage/sql";
import { describeFileCheck, type FileCheck } from "./backups";

const BUILD_KEY = "app.build";

export interface AppBuild {
  schema: number;
  builtFrom: string;
  builtOn: string;
}

/** The desktop app's own build (src-tauri/src/hulk.rs `app_build`). */
export const tauriAppBuild = (): Promise<AppBuild | null> => invoke<AppBuild>("app_build");

export interface StartupCheck {
  /** This build hadn't run against this database before. */
  updated: boolean;
  /** What the checks found, in sentences; empty when everything is fine or nothing ran. */
  problems: string[];
}

/** Runs the checks when the build changed, and records the build either way. */
export async function startupCheck(
  db: SqlDb,
  tenant: Tenant,
  build: AppBuild,
  checkFiles: () => Promise<FileCheck>,
): Promise<StartupCheck> {
  const stamp = `${build.builtFrom}@${String(build.schema)}`;
  const seen = await getSetting(db, tenant, BUILD_KEY);
  if (seen === stamp) return { updated: false, problems: [] };
  const problems: string[] = [];
  const quick = await db.select<{ quick_check: string }>("PRAGMA quick_check");
  const verdict = quick[0]?.quick_check ?? "no answer";
  if (verdict !== "ok") problems.push(`The database check says: ${verdict}.`);
  const keys = await db.select<{ table: string }>("PRAGMA foreign_key_check");
  if (keys.length > 0) {
    problems.push(`${String(keys.length)} rows point at records that no longer exist.`);
  }
  const files = await checkFiles();
  if (files.missing.length > 0 || files.changed.length > 0) {
    problems.push(describeFileCheck(files));
  }
  await setSetting(db, tenant, BUILD_KEY, stamp);
  return { updated: true, problems };
}

/** The notice for a failed check, with the way out. */
export function startupNotice(check: StartupCheck): string | null {
  if (check.problems.length === 0) return null;
  return `The check after the update found problems: ${check.problems.join(" ")} A backup from before the update is in Settings → Your data.`;
}
