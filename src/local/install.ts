/**
 * Installed local models (M7 step 6, LL-03): which profile is ready to run, and whether the one
 * this computer should have is missing, current or out of date.
 */
import type { LocalProfile } from "./models";

/** As src-tauri/src/model_files.rs keeps it beside each file. */
export interface InstalledFile {
  file: string;
  sha256: string;
  revision: string;
  sizeBytes: number;
  installedMs: number;
}

export type InstallStatus =
  | { kind: "missing" }
  | { kind: "installed"; file: InstalledFile }
  /** The file is there, but data/local-models.json now names a different build of it. */
  | { kind: "update"; file: InstalledFile };

export function statusFor(
  profile: LocalProfile,
  installed: readonly InstalledFile[],
): InstallStatus {
  const file = installed.find((f) => f.file === profile.file);
  if (!file) return { kind: "missing" };
  return file.sha256 === profile.sha256 ? { kind: "installed", file } : { kind: "update", file };
}

/** The model FUSE runs: the largest profile installed with its current checksum. */
export function usableProfile(
  installed: readonly InstalledFile[],
  profiles: readonly LocalProfile[],
): LocalProfile | null {
  return profiles.find((p) => statusFor(p, installed).kind === "installed") ?? null;
}

export type InstallMsg =
  { kind: "progress"; done: number; total: number } | { kind: "verifying" } | { kind: "done" };
