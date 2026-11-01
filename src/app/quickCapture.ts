// Global quick capture (CH-08, PL-07): the shortcut lives in Rust (src-tauri/src/quick.rs);
// pressing it brings FUSE forward and the app opens a new chat.
import { invoke } from "@/platform/core";
import { listen } from "@/platform/desktop";

export const DEFAULT_SHORTCUT = "Ctrl+Alt+Space";
/** Settings key; the value "off" turns it off. */
export const SHORTCUT_SETTING = "quick_capture.shortcut";

export interface ShortcutStatus {
  shortcut: string | null;
  /** The desktop may not deliver global shortcuts (Wayland). */
  mayNotWork: boolean;
}

export interface QuickCaptureApi {
  set(shortcut: string | null): Promise<ShortcutStatus>;
  /** Calls `run` whenever the shortcut is pressed; returns a function that stops listening. */
  onCapture(run: () => void): Promise<() => void>;
}

export const tauriQuickCapture: QuickCaptureApi = {
  set: (shortcut) => invoke<ShortcutStatus>("quick_capture_set", { shortcut }),
  onCapture: (run) => listen("quick-capture", run),
};
