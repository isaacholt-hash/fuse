/**
 * Which local model this computer gets (M7 step 5, LL-03). The largest profile whose estimated
 * peak memory is within 40% of the computer's RAM and whose file fits on disk with 1 GB to
 * spare; none on a processor without AVX2. FUSE works the same without one.
 */
import type { LocalProfile } from "./models";

/** As src-tauri/src/hardware.rs reports it. */
export interface Hardware {
  os: string;
  arch: string;
  logicalCpus: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  cpuSupported: boolean;
  freeDiskBytes: number | null;
}

/** Of total RAM, what a local model may take; the rest is for the system, FUSE and your apps. */
export const MEMORY_SHARE = 0.4;
export const DISK_SPARE_BYTES = 1_000_000_000;

export interface ProfileChoice {
  profile: LocalProfile | null;
  /** Why this one (or why none), in plain words. */
  reason: string;
  /** Set when the model fits but there isn't that much memory free right now. */
  warning: string | null;
}

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function pickProfile(hw: Hardware, profiles: readonly LocalProfile[]): ProfileChoice {
  const none = (reason: string): ProfileChoice => ({ profile: null, reason, warning: null });
  if (hw.arch !== "x86_64") {
    return none("Local models need a 64-bit Intel or AMD processor; FUSE uses the cloud here.");
  }
  if (!hw.cpuSupported) {
    return none(
      "This computer's processor lacks AVX2, which the local model needs; FUSE uses the cloud here.",
    );
  }
  const budget = hw.totalMemoryBytes * MEMORY_SHARE;
  const byMemory = profiles.filter((p) => p.peakMemoryBytes <= budget);
  if (byMemory.length === 0) {
    const smallest = profiles.at(-1);
    return none(
      `The smallest local model needs about ${gb(smallest?.peakMemoryBytes ?? 0)} of memory, more than FUSE will take from this computer's ${gb(hw.totalMemoryBytes)}.`,
    );
  }
  const fits = byMemory.find(
    (p) => hw.freeDiskBytes === null || p.sizeBytes + DISK_SPARE_BYTES <= hw.freeDiskBytes,
  );
  if (!fits) {
    const smallest = byMemory.at(-1);
    return none(
      `Not enough free disk: ${smallest?.displayName ?? "the model"} needs ${gb((smallest?.sizeBytes ?? 0) + DISK_SPARE_BYTES)} and ${gb(hw.freeDiskBytes ?? 0)} is free.`,
    );
  }
  const larger = profiles.find((p) => p.peakMemoryBytes > fits.peakMemoryBytes);
  const reason = larger
    ? `${fits.displayName} fits: it needs about ${gb(fits.peakMemoryBytes)} of this computer's ${gb(hw.totalMemoryBytes)}; ${larger.displayName} would need ${gb(larger.peakMemoryBytes)}.`
    : `${fits.displayName} fits: it needs about ${gb(fits.peakMemoryBytes)} of this computer's ${gb(hw.totalMemoryBytes)}.`;
  const warning =
    hw.availableMemoryBytes < fits.peakMemoryBytes
      ? `Only ${gb(hw.availableMemoryBytes)} is free right now; close some apps before using it.`
      : null;
  return { profile: fits, reason, warning };
}
