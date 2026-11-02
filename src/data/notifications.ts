// M10 step 21 (PL-07, review item 19): quiet by default. Every sound, system notification and
// banner has a switch; the sound is off unless turned on; quiet hours silence the lot while
// the home screen keeps showing what waits.
import type { Tenant } from "@/storage/defaults";
import { getSetting, setSetting } from "@/storage/settings";
import type { SqlDb } from "@/storage/sql";

export const NOTIFICATIONS_KEY = "notifications";

/** What a system notification can be about. */
export type SystemKind = "waiting" | "finished" | "budget";
/** The bars the app shows on its own. */
export type BannerKind = "update" | "routing" | "models" | "prices" | "continueInCode" | "budget";

export interface QuietHours {
  on: boolean;
  /** Sunday first, as in schedules. */
  days: boolean[];
  /** Minutes past local midnight; `from === to` means the whole day. */
  from: number;
  to: number;
}

export interface NotificationSettings {
  /** A short chime with each system notification. Off until you turn it on. */
  sound: boolean;
  system: Record<SystemKind, boolean>;
  banners: Record<BannerKind, boolean>;
  quiet: QuietHours;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  sound: false,
  system: { waiting: true, finished: true, budget: true },
  banners: {
    update: true,
    routing: true,
    models: true,
    prices: true,
    continueInCode: true,
    budget: true,
  },
  quiet: { on: false, days: [true, true, true, true, true, true, true], from: 22 * 60, to: 7 * 60 },
};

export const SYSTEM_LABELS: Record<SystemKind, string> = {
  waiting: "A run is waiting for you",
  finished: "A run finished or failed",
  budget: "A budget alert",
};

export const BANNER_LABELS: Record<BannerKind, string> = {
  update: "An update is ready",
  routing: "A routing rule to add",
  models: "A model is missing from a tier",
  prices: "Prices need checking",
  continueInCode: "Continue in Code",
  budget: "Budget and spend alerts",
};

const minute = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1440 ? v : fallback;

const flags = <K extends string>(v: unknown, defaults: Record<K, boolean>): Record<K, boolean> => {
  const out = { ...defaults };
  if (v && typeof v === "object") {
    for (const k of Object.keys(defaults) as K[]) {
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === "boolean") out[k] = x;
    }
  }
  return out;
};

/** The saved settings, with anything missing or odd replaced by the default. */
export function parseNotificationSettings(raw: string | null): NotificationSettings {
  if (!raw) return DEFAULT_NOTIFICATIONS;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return DEFAULT_NOTIFICATIONS;
  }
  if (!v || typeof v !== "object") return DEFAULT_NOTIFICATIONS;
  const o = v as Record<string, unknown>;
  const q = o.quiet && typeof o.quiet === "object" ? (o.quiet as Record<string, unknown>) : {};
  const days =
    Array.isArray(q.days) && q.days.length === 7 ? q.days : DEFAULT_NOTIFICATIONS.quiet.days;
  return {
    sound: typeof o.sound === "boolean" ? o.sound : DEFAULT_NOTIFICATIONS.sound,
    system: flags(o.system, DEFAULT_NOTIFICATIONS.system),
    banners: flags(o.banners, DEFAULT_NOTIFICATIONS.banners),
    quiet: {
      on: typeof q.on === "boolean" ? q.on : false,
      days: days.map((d) => d === true),
      from: minute(q.from, DEFAULT_NOTIFICATIONS.quiet.from),
      to: minute(q.to, DEFAULT_NOTIFICATIONS.quiet.to),
    },
  };
}

export async function getNotificationSettings(
  db: SqlDb,
  tenant: Tenant,
): Promise<NotificationSettings> {
  return parseNotificationSettings(await getSetting(db, tenant, NOTIFICATIONS_KEY));
}

export async function setNotificationSettings(
  db: SqlDb,
  tenant: Tenant,
  settings: NotificationSettings,
): Promise<void> {
  await setSetting(db, tenant, NOTIFICATIONS_KEY, JSON.stringify(settings));
}

/** Whether `now` falls in the quiet hours. An overnight range runs into the next morning. */
export function inQuietHours(quiet: QuietHours, now: Date): boolean {
  if (!quiet.on) return false;
  const day = now.getDay();
  const m = now.getHours() * 60 + now.getMinutes();
  const { from, to } = quiet;
  const on = (d: number) => quiet.days[d] === true;
  if (from === to) return on(day);
  if (from < to) return on(day) && m >= from && m < to;
  // Overnight: this evening on a quiet day, or this morning after a quiet day.
  return (on(day) && m >= from) || (on((day + 6) % 7) && m < to);
}

/** Whether a system notification of this kind may show right now. */
export function mayNotify(
  settings: NotificationSettings,
  kind: SystemKind,
  now = new Date(),
): boolean {
  return settings.system[kind] && !inQuietHours(settings.quiet, now);
}

export const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export const toMinute = (hhmmText: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmmText);
  if (!match) return null;
  const h = Number(match[1]);
  const mi = Number(match[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Quiet 22:00 to 07:00 on Mon, Tue, Wed, Thu, Fri", or "Quiet hours off". */
export function describeQuiet(quiet: QuietHours): string {
  if (!quiet.on) return "Quiet hours off";
  const days = quiet.days.every(Boolean)
    ? "every day"
    : quiet.days.some(Boolean)
      ? `on ${DAY_NAMES.filter((_, i) => quiet.days[i]).join(", ")}`
      : "on no day";
  const range = quiet.from === quiet.to ? "all day" : `${hhmm(quiet.from)} to ${hhmm(quiet.to)}`;
  return `Quiet ${range} ${days}`;
}

/** A short two-note chime through the webview's audio, when the browser has it. */
export function playChime(): void {
  try {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const at = ctx.currentTime;
    for (const [freq, start] of [
      [660, 0],
      [880, 0.12],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at + start);
      gain.gain.exponentialRampToValueAtTime(0.2, at + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + start + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at + start);
      osc.stop(at + start + 0.2);
    }
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // No audio here; the notification still shows.
  }
}
