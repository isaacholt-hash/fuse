import { getVersion, relaunch, check, type Update } from "@/platform/desktop";
import { isDesktop as isTauri } from "@/platform/core";

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
      // Already downloaded: nothing to fetch again. A newer one replaces it (F1).
      if (ready?.version === update.version) return update.version;
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

/** Outside an installed build (tests, the browser preview, `pnpm tauri dev`) there is nothing to update. */
export const noUpdates: UpdateApi = {
  version: () => Promise.resolve("dev"),
  prepare: () => Promise.resolve(null),
  installAndRestart: () => Promise.resolve(),
};

/**
 * The web app on HULK (M10 step 5): it's updated with the server, never by itself, and shows
 * the server's version (PL-06).
 */
export const serverUpdates = (version: string): UpdateApi => ({
  version: () => Promise.resolve(version),
  prepare: () => Promise.resolve(null),
  installAndRestart: () => Promise.resolve(),
});

export const defaultUpdateApi = (): UpdateApi =>
  isTauri() && !import.meta.env.DEV ? tauriUpdateApi() : noUpdates;
