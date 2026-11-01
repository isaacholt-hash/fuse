// Following runs handed over to HULK from this desktop (M10 steps 7 and 8): which ones it sent
// (kept in this computer's localStorage, by chat), how each is going, and when that's worth a
// system notification.
import type { HandoverState } from "./handover";

/** A run this desktop handed over. */
export interface HandedOver {
  requestId: string;
  threadId: string;
  task: string;
  at: number;
}

const KEY = "fuse.handovers";

export function readHandovers(): HandedOver[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as HandedOver[]) : [];
  } catch {
    return [];
  }
}

export function addHandover(h: HandedOver): HandedOver[] {
  // The newest 50 are enough to follow; older ones are on HULK's Runs list.
  const all = [...readHandovers().filter((x) => x.requestId !== h.requestId), h].slice(-50);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // not remembered past a reload
  }
  return all;
}

/** How a handed-over run shows here. */
export type HandoverLook =
  "starting" | "going" | "waiting" | "done" | "failed" | "stopped" | "paused";

export const LOOK_LABEL: Record<HandoverLook, string> = {
  starting: "Starting on HULK",
  going: "Going",
  waiting: "Waiting for you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  paused: "Paused",
};

export function lookOf(s: HandoverState): HandoverLook {
  switch (s.status) {
    case "queued":
      return "starting";
    case "running":
      return s.waiting ? "waiting" : "going";
    case "error":
    case "failed":
      return "failed";
    default:
      return s.status;
  }
}

/**
 * Whether a change is worth a notification: a run that was starting, going or waiting is now
 * waiting for you, done or failed. Null for anything else, including the first look at a run.
 */
export function notifyFor(before: HandoverLook | undefined, now: HandoverLook): string | null {
  if (before === undefined || before === now) return null;
  if (before !== "starting" && before !== "going" && before !== "waiting") return null;
  if (now === "waiting" || now === "done" || now === "failed") return LOOK_LABEL[now];
  return null;
}

/** Shows a system notification; resolves false when it can't, so the app shows its own. */
export type Notifier = (title: string, body: string) => Promise<boolean>;

/**
 * The webview's own Notification API (no new plugin): it shows a system notification where the
 * webview allows it, after asking once.
 */
export const webviewNotifier: Notifier = async (title, body) => {
  if (typeof Notification === "undefined") return false;
  try {
    const allowed =
      Notification.permission === "granted" ||
      (Notification.permission === "default" &&
        (await Notification.requestPermission()) === "granted");
    if (!allowed) return false;
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
};
