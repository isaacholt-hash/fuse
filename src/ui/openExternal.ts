import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Opens http(s)/mailto links in the system browser; anything else is ignored. */
export function openExternal(href: string | undefined): void {
  if (!href || !/^(https?:|mailto:)/i.test(href)) return;
  if (isTauri()) void openUrl(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}
