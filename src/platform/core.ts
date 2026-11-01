/**
 * The one place the app reaches its platform (M10 step 1). On the desktop that's Tauri; in the
 * web app on HULK, and in the runner there, it's fuse-server over HTTP and a WebSocket
 * (`./http`). Every api module imports `invoke` and `Channel` from here, never from Tauri.
 */
import {
  Channel as TauriChannel,
  convertFileSrc as tauriConvertFileSrc,
  invoke as tauriInvoke,
  isTauri,
} from "@tauri-apps/api/core";
import { Channel, type Args, type InvokeOptions } from "./channel";
import { httpConvertFileSrc, httpInvoke } from "./http";

export { Channel, type Args, type InvokeOptions };

/** True in the desktop app, false in a browser or the runner. */
export const isDesktop = (): boolean => isTauri();

/** Calls a backend command, like Tauri's `invoke`; rejects with the command's error value. */
export function invoke<T>(
  cmd: string,
  args?: Args | Uint8Array,
  options?: InvokeOptions,
): Promise<T> {
  if (!isDesktop()) return httpInvoke<T>(cmd, args, options);
  if (!args || args instanceof Uint8Array) return tauriInvoke<T>(cmd, args, options);
  const tauriArgs: Args = {};
  for (const [k, v] of Object.entries(args)) {
    if (v instanceof Channel) {
      const ch = new TauriChannel<unknown>();
      ch.onmessage = (m) => {
        v.deliver(m);
      };
      tauriArgs[k] = ch;
    } else tauriArgs[k] = v;
  }
  return tauriInvoke<T>(cmd, tauriArgs);
}

/** A URL the page can load for a file the backend serves under `protocol` (previews). */
export function convertFileSrc(path: string, protocol: string): string {
  return isDesktop() ? tauriConvertFileSrc(path, protocol) : httpConvertFileSrc(path, protocol);
}
