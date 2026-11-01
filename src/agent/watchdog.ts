// M10 step 11: the stall watchdog. A run that has worked for longer than its wall-clock limit,
// or made no progress for longer than its idle limit, is stopped with a note that says which.
// Time spent waiting for the user's answer counts toward neither, so a question left overnight
// doesn't end the run; the clocks resume when it is answered.
import { formatDuration } from "@/lib/duration";

/** FUSE's defaults, used when a project sets nothing (requirements §11b, M10 step 11). */
export const DEFAULT_RUN_WALL_MINUTES = 120;
export const DEFAULT_RUN_IDLE_MINUTES = 15;

export interface WatchdogLimits {
  /** Active time the run may take in all, in milliseconds. */
  wallMs: number;
  /** Active time it may go without any progress, in milliseconds. */
  idleMs: number;
}

export type TripReason = "wall" | "idle";

/** The note a tripped watchdog leaves on the run. */
export function tripNote(reason: TripReason, limits: WatchdogLimits): string {
  return reason === "idle"
    ? `Stopped: no progress for ${formatDuration(limits.idleMs)}.`
    : `Stopped: ran for ${formatDuration(limits.wallMs)}.`;
}

export class Watchdog {
  private readonly now: () => number;
  private readonly onTrip: (reason: TripReason, note: string) => void;
  private startedAt = 0;
  private lastProgressAt = 0;
  /** When the current wait began, or null while the run is working. */
  private waitingSince: number | null = null;
  /** Waiting time already finished, in this leg. */
  private waitedMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tripped: TripReason | null = null;

  constructor(
    readonly limits: WatchdogLimits,
    options: { now?: () => number; onTrip: (reason: TripReason, note: string) => void },
  ) {
    this.now = options.now ?? Date.now;
    this.onTrip = options.onTrip;
  }

  /** Starts both clocks. Checks often enough for short limits (tests), at most every 15 s. */
  start(): void {
    const t = this.now();
    this.startedAt = t;
    this.lastProgressAt = t;
    const every = Math.max(
      10,
      Math.min(15_000, Math.floor(Math.min(this.limits.wallMs, this.limits.idleMs) / 2)),
    );
    this.timer = setInterval(() => {
      this.check();
    }, every);
    // Node: the timer must not keep the runner process alive on its own.
    const t2 = this.timer as { unref?: () => void };
    t2.unref?.();
  }

  /** Something happened: a streamed delta, a finished step, an answered question. */
  progress(): void {
    this.lastProgressAt = this.now();
  }

  /**
   * `waiting(true)` pauses both clocks while a question waits for the user; `waiting(false)`
   * resumes them and returns how long that wait took, so the run can record it.
   */
  waiting(on: boolean): number {
    const t = this.now();
    if (on) {
      if (this.waitingSince === null) this.waitingSince = t;
      return 0;
    }
    if (this.waitingSince === null) return 0;
    const took = t - this.waitingSince;
    this.waitingSince = null;
    this.waitedMs += took;
    this.lastProgressAt = t;
    return took;
  }

  /** Active time so far: since start, less time spent waiting. */
  activeMs(): number {
    const t = this.now();
    const waitingNow = this.waitingSince === null ? 0 : t - this.waitingSince;
    return t - this.startedAt - this.waitedMs - waitingNow;
  }

  /** Active time since the last progress. */
  idleMs(): number {
    if (this.waitingSince !== null) return 0;
    return this.now() - this.lastProgressAt;
  }

  /** Looks once; trips at most once. Also called by the timer. */
  check(): TripReason | null {
    if (this.tripped || this.waitingSince !== null) return this.tripped;
    const reason: TripReason | null =
      this.activeMs() >= this.limits.wallMs
        ? "wall"
        : this.idleMs() >= this.limits.idleMs
          ? "idle"
          : null;
    if (reason) {
      this.tripped = reason;
      this.stop();
      this.onTrip(reason, tripNote(reason, this.limits));
    }
    return reason;
  }

  /** Why it stopped the run, if it did. */
  get reason(): TripReason | null {
    return this.tripped;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
