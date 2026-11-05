import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, getThread, markThreadSeen, markThreadUnread } from "@/storage/threads";
import type { LatestRun } from "@/storage/runs";
import { useSeenResult } from "./useSeenResult";

afterEach(cleanup);

test("equivalent sidebar refreshes cannot enqueue repeated seen writes while the database is busy", async () => {
  const db = openTestDb();
  const thread = await createThread(db, tenant, "Recorded completed run");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn(async (...args: Parameters<typeof db.execute>) => {
    await held;
    return db.execute(...args);
  });
  const delayed = { ...db, execute };
  const refresh = vi.fn(() => Promise.resolve());
  const latest: LatestRun = { runId: "root", status: "done", updatedAt: 100 };
  const hook = renderHook(
    ({ latest }) => {
      useSeenResult(delayed, tenant, thread.id, latest, null, refresh);
    },
    { initialProps: { latest } },
  );
  await waitFor(() => {
    expect(execute).toHaveBeenCalledTimes(1);
  });
  for (let i = 0; i < 20; i++) hook.rerender({ latest: { ...latest } });
  expect(execute).toHaveBeenCalledTimes(1);
  await act(async () => {
    release();
    await held;
  });
  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  expect((await getThread(db, tenant, thread.id))?.seenAt).toBeGreaterThanOrEqual(100);
});

test("a delayed automatic update cannot clear a subsequent explicit unread mark", async () => {
  const db = openTestDb();
  const thread = await createThread(db, tenant, "Recorded result");
  await markThreadSeen(db, tenant, thread.id, 100);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn(async (...args: Parameters<typeof db.execute>) => {
    await held;
    return db.execute(...args);
  });
  const refresh = vi.fn(() => Promise.resolve());
  renderHook(() => {
    useSeenResult(
      { ...db, execute },
      tenant,
      thread.id,
      { runId: "root", status: "done", updatedAt: 200 },
      100,
      refresh,
    );
  });
  await waitFor(() => {
    expect(execute).toHaveBeenCalledTimes(1);
  });
  await markThreadUnread(db, tenant, thread.id);
  await act(async () => {
    release();
    await held;
  });
  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  expect((await getThread(db, tenant, thread.id))?.seenAt).toBe(0);
});

test("a future-dated result settles once instead of writing until the wall clock catches up", async () => {
  const db = openTestDb();
  const thread = await createThread(db, tenant, "Clock skew");
  const execute = vi.fn((...args: Parameters<typeof db.execute>) => db.execute(...args));
  const scoped = { ...db, execute };
  const refresh = vi.fn(() => Promise.resolve());
  const latest: LatestRun = { runId: "root", status: "done", updatedAt: Date.now() + 60_000 };
  const initialProps: { seenAt: number | null } = { seenAt: null };
  const hook = renderHook(
    ({ seenAt }) => {
      useSeenResult(scoped, tenant, thread.id, latest, seenAt, refresh);
    },
    { initialProps },
  );
  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  expect((await getThread(db, tenant, thread.id))?.seenAt).toBe(latest.updatedAt);
  hook.rerender({ seenAt: latest.updatedAt });
  expect(execute).toHaveBeenCalledTimes(1);
});
