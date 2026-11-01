/**
 * Desktop-only pieces of Tauri (updater, process, opener, webview zoom, app events), so nothing
 * outside `src/platform` imports Tauri. Callers check `isDesktop()` first; on the web these are
 * greyed or replaced (M10 step 5).
 */
export { getVersion } from "@tauri-apps/api/app";
export { listen } from "@tauri-apps/api/event";
export { getCurrentWebview } from "@tauri-apps/api/webview";
export { relaunch } from "@tauri-apps/plugin-process";
export { openUrl } from "@tauri-apps/plugin-opener";
export { check, type Update } from "@tauri-apps/plugin-updater";
