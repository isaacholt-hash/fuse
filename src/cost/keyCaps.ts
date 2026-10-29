/**
 * Spend caps per key (MM-09): a daily and a monthly dollar limit for each provider's key. Past
 * one, FUSE makes no more calls on that key (a hard stop) until the period ends, or until
 * tomorrow if you raise it for today with one click.
 */
import type { ProviderId } from "@/catalog/catalog";

export const CAPS_SETTING = "keys.caps";
/** The local day (YYYY-MM-DD) each provider's caps were lifted for. */
export const RAISED_SETTING = "keys.caps_raised";

export interface KeyCap {
  /** Micro-dollars; unset means no cap. */
  dailyMicro?: number;
  monthlyMicro?: number;
}
export type KeyCaps = Partial<Record<ProviderId, KeyCap>>;
export type CapRaises = Partial<Record<ProviderId, string>>;

export interface CapState {
  provider: ProviderId;
  cap: KeyCap;
  spentToday: number;
  spentMonth: number;
  /** Which cap is reached, if any. */
  over: "day" | "month" | null;
  /** Lifted for today. */
  raised: boolean;
}

/** The local calendar day, e.g. "2026-10-29". */
export function localDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function capState(
  provider: ProviderId,
  cap: KeyCap,
  spent: { today: number; month: number },
  raisedOn: string | undefined,
  now: number,
): CapState {
  const over =
    cap.dailyMicro !== undefined && spent.today >= cap.dailyMicro
      ? "day"
      : cap.monthlyMicro !== undefined && spent.month >= cap.monthlyMicro
        ? "month"
        : null;
  return {
    provider,
    cap,
    spentToday: spent.today,
    spentMonth: spent.month,
    over,
    raised: raisedOn === localDay(now),
  };
}

function jsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export const parseCaps = (raw: string | null) => jsonObject(raw) as KeyCaps;
export const parseRaises = (raw: string | null) => jsonObject(raw) as CapRaises;
