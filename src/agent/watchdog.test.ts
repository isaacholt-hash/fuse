// M10 step 11: the stall watchdog, on a fake clock.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tripNote, Watchdog, type TripReason } from "./watchdog";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const MIN = 60_000;

function dog(limits = { wallMs: 120 * MIN, idleMs: 15 * MIN }) {
  const trips: { reason: TripReason; note: string }[] = [];
  const w = new Watchdog(limits, {
    onTrip: (reason, note) => {
      trips.push({ reason, note });
    },
  });
  w.start();
  return { w, trips };
}

test("no progress for the idle limit stops the run and says for how long", () => {
  const { w, trips } = dog();
  vi.advanceTimersByTime(14 * MIN);
  expect(trips).toEqual([]);
  vi.advanceTimersByTime(2 * MIN);
  expect(trips).toEqual([{ reason: "idle", note: "Stopped: no progress for 15 min." }]);
  expect(w.reason).toBe("idle");
  // It trips once; later checks change nothing.
  vi.advanceTimersByTime(60 * MIN);
  expect(trips).toHaveLength(1);
  w.stop();
});

test("progress resets the idle clock, and the wall clock still ends it", () => {
  const { w, trips } = dog({ wallMs: 60 * MIN, idleMs: 15 * MIN });
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(10 * MIN);
    w.progress();
  }
  expect(trips).toEqual([]);
  vi.advanceTimersByTime(10 * MIN);
  w.progress();
  vi.advanceTimersByTime(1 * MIN);
  expect(trips).toEqual([{ reason: "wall", note: "Stopped: ran for 1 h." }]);
  w.stop();
});

test("time spent waiting for an answer counts toward neither limit", () => {
  const { w, trips } = dog({ wallMs: 30 * MIN, idleMs: 10 * MIN });
  vi.advanceTimersByTime(5 * MIN);
  w.waiting(true);
  // Overnight: no trip while the question waits.
  vi.advanceTimersByTime(8 * 60 * MIN);
  expect(trips).toEqual([]);
  expect(w.waiting(false)).toBe(8 * 60 * MIN);
  expect(w.activeMs()).toBe(5 * MIN);
  expect(w.idleMs()).toBe(0);
  vi.advanceTimersByTime(9 * MIN);
  expect(trips).toEqual([]);
  vi.advanceTimersByTime(2 * MIN);
  expect(trips.map((t) => t.reason)).toEqual(["idle"]);
  w.stop();
});

test("short limits are checked often enough; stop ends the timer", () => {
  const { w, trips } = dog({ wallMs: 10 * MIN, idleMs: 40 });
  vi.advanceTimersByTime(60);
  expect(trips.map((t) => t.reason)).toEqual(["idle"]);
  const { w: quiet, trips: none } = dog({ wallMs: 10 * MIN, idleMs: 40 });
  quiet.stop();
  vi.advanceTimersByTime(1000);
  expect(none).toEqual([]);
  w.stop();
});

test("the notes read in whole units", () => {
  expect(tripNote("idle", { wallMs: 0, idleMs: 90 * MIN })).toBe(
    "Stopped: no progress for 1 h 30 min.",
  );
  expect(tripNote("wall", { wallMs: 45_000, idleMs: 0 })).toBe("Stopped: ran for 45 s.");
});
