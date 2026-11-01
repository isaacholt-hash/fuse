// @vitest-environment node
// M10 step 17: Usage by area and by where each request came from.
import { afterEach, expect, test } from "vitest";
import { DEFAULT_TENANT } from "./defaults";
import { logRequest, setRequestSurface } from "./requestLog";
import { createThread, setThreadSchedule } from "./threads";
import { openTestDb } from "./testing/nodeDb";
import { EMPTY_USAGE } from "./usage";
import { listUsage } from "./usageReport";

const t = DEFAULT_TENANT;
afterEach(() => {
  setRequestSurface(null);
});

const entry = (threadId: string | null) => ({
  threadId,
  messageId: null,
  purpose: "agent" as const,
  provider: "anthropic",
  model: "m",
  attempt: 1,
  usage: { ...EMPTY_USAGE, costMicroUsd: 100 },
  httpStatus: 200,
  errorCode: null,
  errorMessage: null,
  providerRequestId: null,
});

test("each request records where it came from; a scheduled task's runner rows count as scheduled", async () => {
  const db = openTestDb();
  const chat = await createThread(db, t, "Notes");
  const session = await createThread(db, t, "Fix it", null, false, "code");
  const nightly = await createThread(db, t, "Nightly", null, false, "code");
  await setThreadSchedule(db, t, nightly.id, "schedule-1");

  await logRequest(db, t, entry(null));
  setRequestSurface("desktop");
  await logRequest(db, t, entry(chat.id));
  setRequestSurface("runner");
  await logRequest(db, t, entry(session.id));
  await logRequest(db, t, entry(nightly.id));

  const rows = await listUsage(db, t, 0);
  // Written in the same millisecond, so compared as a set.
  expect(rows.map((r) => `${String(r.area)}/${String(r.surface)}`).sort()).toEqual([
    "chat/desktop",
    "code/runner",
    "code/scheduled",
    "null/null",
  ]);
});
