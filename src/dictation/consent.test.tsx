import { act, cleanup, renderHook } from "@testing-library/react";
import { clearAudioConsent, setAudioConsent, useAudioConsent } from "./consent";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import type { SqlDb } from "@/storage/sql";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
test("consent stays local, fails closed and revokes before a failed audit", async () => {
  const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const db: SqlDb = {
    execute,
    select: () => Promise.resolve([]),
    batch: () => Promise.resolve([]),
  };
  const hook = renderHook(useAudioConsent);
  expect(hook.result.current).toBe(false);
  execute.mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(setAudioConsent(db, tenant, true)).rejects.toThrow("Storage unavailable");
  expect(hook.result.current).toBe(false);
  await act(() => setAudioConsent(db, tenant, true));
  expect(hook.result.current).toBe(true);
  expect(execute.mock.calls.at(-1)?.[0]).toContain("security_audit");
  expect(execute.mock.calls.at(-1)?.[1]).toContain("set");
  expect(execute.mock.calls.at(-1)?.[0]).not.toContain("INSERT INTO settings");
  execute.mockRejectedValueOnce(new Error("Storage unavailable"));
  await act(async () => {
    await expect(setAudioConsent(db, tenant, false)).rejects.toThrow();
  });
  expect(hook.result.current).toBe(false);
  await act(() => setAudioConsent(db, tenant, true));
  act(clearAudioConsent);
  expect(hook.result.current).toBe(false);
});
