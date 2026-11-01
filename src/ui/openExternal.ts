import { isDesktop as isTauri } from "@/platform/core";
import { openUrl } from "@/platform/desktop";

/** Opens http(s)/mailto links in the system browser; anything else is ignored. */
export function openExternal(href: string | undefined): void {
  if (!href || !/^(https?:|mailto:)/i.test(href)) return;
  if (isTauri()) void openUrl(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}
