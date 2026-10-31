/**
 * The Python runtime for data work (M9 step 5, AG-03), from data/python.json: a pinned CPython
 * build per platform and a lock of its libraries with hashes. Installed only when you ask, by the
 * Rust side (src-tauri/src/python_runtime.rs). Nothing runs scripts until step 6.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import raw from "../../data/python.json";
import linuxLock from "../../data/python/requirements-linux.txt?raw";
import windowsLock from "../../data/python/requirements-windows.txt?raw";

export type PythonPlatform = "linux-x86_64" | "windows-x86_64";

export interface PythonPin {
  python: string;
  release: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  /** The requirements lock: every library pinned with its hashes. */
  lock: string;
  /** "pandas==3.0.6", …: what the lock installs. */
  packages: string[];
}

const LOCKS: Record<PythonPlatform, string> = {
  "linux-x86_64": linuxLock,
  "windows-x86_64": windowsLock,
};

/** The libraries a lock pins, as "name==version". */
export const pinnedIn = (lock: string): string[] =>
  lock
    .split("\n")
    .filter((l) => /^[A-Za-z0-9]/.test(l))
    .map((l) => l.split(/\s/)[0] ?? "")
    .filter(Boolean);

/** The pin for a platform, or null where FUSE has no build (macOS, Arm). */
export function pythonPin(platform: PythonPlatform | null): PythonPin | null {
  if (!platform) return null;
  const p = raw.platforms[platform];
  const lock = LOCKS[platform];
  return {
    python: raw.python,
    release: raw.release,
    url: p.url,
    sha256: p.sha256,
    sizeBytes: p.size_bytes,
    lock,
    packages: pinnedIn(lock),
  };
}

/** This computer's platform, as FUSE builds for it: Windows or Linux, both x86-64 (PL-01). */
export function thisPlatform(ua: string = navigator.userAgent): PythonPlatform | null {
  if (/Windows/.test(ua)) return "windows-x86_64";
  if (/Linux/.test(ua) && !/aarch64|arm/i.test(ua)) return "linux-x86_64";
  return null;
}

/** What's installed, from the note beside it. */
export interface PythonRuntime {
  python: string;
  release: string;
  packages: string[];
  sizeBytes: number;
  installedMs: number;
}

export type PythonMsg =
  | { kind: "progress"; done: number; total: number }
  | { kind: "verifying" }
  | { kind: "unpacking" }
  | { kind: "libraries" }
  | { kind: "done" };

export interface PythonApi {
  status(): Promise<PythonRuntime | null>;
  install(pin: PythonPin, onMsg: (m: PythonMsg) => void): Promise<PythonRuntime>;
  cancel(): Promise<void>;
  remove(): Promise<void>;
}

export const tauriPythonApi: PythonApi = {
  status: () => invoke<PythonRuntime | null>("python_status"),
  install: (pin, onMsg) => {
    const onEvent = new Channel<PythonMsg>();
    onEvent.onmessage = onMsg;
    return invoke<PythonRuntime>("python_install", {
      url: pin.url,
      sha256: pin.sha256,
      sizeBytes: pin.sizeBytes,
      python: pin.python,
      release: pin.release,
      lock: pin.lock,
      packages: pin.packages,
      onEvent,
    });
  },
  cancel: () => invoke("python_install_cancel"),
  remove: () => invoke("python_remove"),
};
