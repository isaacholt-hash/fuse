import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/**
 * Auto-update (M1 C3, docs/releases.md): each merge to main publishes a signed release; the app
 * downloads a newer one in the background and installs it when Isaac clicks Restart.
 */
export interface UpdateApi {
  version(): Promise<string>;
  /** Checks for a newer release and downloads it. Resolves to its version, or null if current. */
  prepare(): Promise<string | null>;
  /** Installs the downloaded update and restarts (Windows quits the app to run the installer). */
  installAndRestart(): Promise<void>;
}

export function tauriUpdateApi(): UpdateApi {
  let ready: Update | null = null;
  return {
    version: getVersion,
    async prepare() {
      const update = await check();
      if (!update) return null;
      await update.download();
      ready = update;
      return update.version;
    },
    async installAndRestart() {
      if (!ready) throw new Error("No update has been downloaded.");
      await ready.install();
      await relaunch();
    },
  };
}

/** Outside the desktop app (tests, the browser preview) there is nothing to update. */
export const noUpdates: UpdateApi = {
  version: () => Promise.resolve("dev"),
  prepare: () => Promise.resolve(null),
  installAndRestart: () => Promise.resolve(),
};

export const defaultUpdateApi = (): UpdateApi => (isTauri() ? tauriUpdateApi() : noUpdates);
