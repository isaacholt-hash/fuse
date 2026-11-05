// @vitest-environment node
import { openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createThread, getThread } from "@/storage/threads";
import { createProject } from "@/storage/projects";
import { logRequest } from "@/storage/requestLog";
import { EMPTY_USAGE } from "@/storage/usage";
import { spentSince } from "@/storage/budgets";

test("discarding a transcript preserves its fee in thread, project and global totals exactly once", async () => {
  const db = openTestDb();
  const project = await createProject(db, tenant, "Speech fixture");
  const thread = await createThread(db, tenant, "Draft", project.id);
  await logRequest(db, tenant, {
    purpose: "transcribe",
    provider: "openai",
    model: "gpt-transcribe",
    threadId: thread.id,
    messageId: null,
    projectId: project.id,
    audioDurationMs: 1000,
    billingState: "reported",
    usage: { ...EMPTY_USAGE, costMicroUsd: 75 },
    attempt: 1,
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    providerRequestId: null,
  });
  expect((await getThread(db, tenant, thread.id))?.costMicroUsd).toBe(75);
  expect(await spentSince(db, tenant, 0)).toBe(75);
  expect(await spentSince(db, tenant, 0, project.id)).toBe(75);
  expect(await db.select("SELECT * FROM messages")).toEqual([]);
});
