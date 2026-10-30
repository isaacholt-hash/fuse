import { act, renderHook } from "@testing-library/react";
import type { UpdateApi } from "@/update/api";
import { FOCUS_CHECK_MIN_MS, UPDATE_CHECK_MS, useUpdate } from "./useUpdate";

/** A fake release feed: `latest` is what a check finds (null = up to date). */
function feed(latest: string | null = null) {
  const api = {
    latest,
    checks: 0,
    version: () => Promise.resolve("0.1.100"),
    prepare: () => {
      api.checks++;
      return Promise.resolve(api.latest);
    },
    installAndRestart: () => Promise.resolve(),
  };
  return api as typeof api & UpdateApi;
}

let clock = 1_000_000;
const now = () => clock;
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
});
afterEach(() => {
  vi.useRealTimers();
});

test("checks at start and then every 30 minutes, not 6 hours", async () => {
  const api = feed();
  const { result } = renderHook(() => useUpdate(api, now));
  await settle();
  expect(api.checks).toBe(1);
  expect(result.current.update).toEqual({ kind: "none" });
  api.latest = "0.1.101";
  await act(async () => {
    clock += UPDATE_CHECK_MS;
    vi.advanceTimersByTime(UPDATE_CHECK_MS);
    await Promise.resolve();
  });
  await settle();
  expect(api.checks).toBe(2);
  expect(result.current.update).toEqual({ kind: "ready", version: "0.1.101" });
});

test("coming back to the window checks again, at most every 5 minutes", async () => {
  const api = feed();
  renderHook(() => useUpdate(api, now));
  await settle();
  clock += 60_000;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await settle();
  expect(api.checks).toBe(1);
  clock += FOCUS_CHECK_MIN_MS;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await settle();
  expect(api.checks).toBe(2);
});

test("Dismiss hides only that version; a newer one shows again", async () => {
  const api = feed("0.1.101");
  const { result } = renderHook(() => useUpdate(api, now));
  await settle();
  act(() => {
    result.current.dismiss();
  });
  expect(result.current.update).toEqual({ kind: "none" });
  api.latest = "0.1.102";
  clock += FOCUS_CHECK_MIN_MS;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await settle();
  expect(result.current.update).toEqual({ kind: "ready", version: "0.1.102" });
});

test("Check for updates says what it found, and shows a dismissed release again", async () => {
  const api = feed(null);
  const { result } = renderHook(() => useUpdate(api, now));
  await settle();
  let r: Awaited<ReturnType<typeof result.current.checkNow>> | undefined;
  await act(async () => {
    r = await result.current.checkNow();
  });
  expect(r).toEqual({ kind: "current" });
  api.latest = "0.1.101";
  await act(async () => {
    r = await result.current.checkNow();
  });
  expect(r).toEqual({ kind: "ready", version: "0.1.101" });
  act(() => {
    result.current.dismiss();
  });
  await act(async () => {
    await result.current.checkNow();
  });
  expect(result.current.update).toEqual({ kind: "ready", version: "0.1.101" });
  const failing = feed();
  failing.prepare = () => Promise.reject(new Error("offline"));
  const { result: offline } = renderHook(() => useUpdate(failing, now));
  await settle();
  await act(async () => {
    r = await offline.current.checkNow();
  });
  expect(r).toEqual({ kind: "failed", message: "offline" });
});
