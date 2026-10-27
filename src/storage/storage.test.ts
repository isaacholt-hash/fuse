// @vitest-environment node
import { DEFAULT_TENANT, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } from "./defaults";
import { addMessage, finishMessage, listMessages, markInterruptedMessages } from "./messages";
import { listRecentRequests, logRequest } from "./requestLog";
import { openTestDb } from "./testing/nodeDb";
import { createThread, deleteThread, getThread, listThreads, renameThread } from "./threads";
import { EMPTY_USAGE } from "./usage";

const t = DEFAULT_TENANT;

// Deterministic clock: every Date.now() call advances 10 ms, so ordering never depends on timing.
beforeEach(() => {
  let clock = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 10));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("migrations", () => {
  test("seed the default workspace and user", async () => {
    const db = openTestDb();
    const ws = await db.select<{ id: string }>("SELECT id FROM workspaces");
    const users = await db.select<{ id: string; workspace_id: string }>(
      "SELECT id, workspace_id FROM users",
    );
    expect(ws).toEqual([{ id: DEFAULT_WORKSPACE_ID }]);
    expect(users).toEqual([{ id: DEFAULT_USER_ID, workspace_id: DEFAULT_WORKSPACE_ID }]);
  });

  test("every table has workspace_id, user_id and created_at", async () => {
    const db = openTestDb();
    const tables = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(tables.length).toBeGreaterThanOrEqual(6);
    for (const { name } of tables) {
      const cols = (await db.select<{ name: string }>(`PRAGMA table_info(${name})`)).map(
        (c) => c.name,
      );
      expect(cols, name).toEqual(expect.arrayContaining(["workspace_id", "user_id", "created_at"]));
    }
  });

  test("no column looks like it stores an API key", async () => {
    const db = openTestDb();
    const tables = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    for (const { name } of tables) {
      for (const c of await db.select<{ name: string }>(`PRAGMA table_info(${name})`)) {
        expect(c.name).not.toMatch(/api_?key|secret|password|token$/i);
      }
    }
  });
});

describe("threads", () => {
  test("create, rename, list newest first, soft delete", async () => {
    const db = openTestDb();
    const a = await createThread(db, t, "First");
    const b = await createThread(db, t);
    await addMessage(db, t, { threadId: a.id, parentId: null, role: "user", content: "hi" });

    await renameThread(db, t, b.id, "Renamed");
    expect((await getThread(db, t, b.id))?.title).toBe("Renamed");
    expect((await getThread(db, t, b.id))?.titleSource).toBe("user");

    expect((await listThreads(db, t)).map((x) => x.id)).toEqual([a.id, b.id]);

    await deleteThread(db, t, a.id);
    expect((await listThreads(db, t)).map((x) => x.id)).toEqual([b.id]);
    expect(await getThread(db, t, a.id)).toBeNull();
  });

  test("other workspaces' threads are invisible", async () => {
    const db = openTestDb();
    await createThread(db, t);
    expect(await listThreads(db, { workspaceId: "other", userId: DEFAULT_USER_ID })).toEqual([]);
  });
});

describe("messages", () => {
  test("stream an answer, then store its usage and roll cost up to the thread", async () => {
    const db = openTestDb();
    const thread = await createThread(db, t);
    const q = await addMessage(db, t, {
      threadId: thread.id,
      parentId: null,
      role: "user",
      content: "2+2?",
    });
    const a = await addMessage(db, t, {
      threadId: thread.id,
      parentId: q,
      role: "assistant",
      content: "",
      status: "streaming",
      provider: "anthropic",
      model: "test-model",
    });
    const requestId = await logRequest(db, t, {
      threadId: thread.id,
      messageId: a,
      purpose: "chat",
      provider: "anthropic",
      model: "test-model",
      attempt: 1,
      usage: { ...EMPTY_USAGE, inputTokens: 12, outputTokens: 3, costMicroUsd: 51 },
      httpStatus: 200,
      errorCode: null,
      errorMessage: null,
      providerRequestId: "req_test",
    });
    await finishMessage(db, t, a, {
      content: "4",
      status: "complete",
      requestId,
      usage: {
        ...EMPTY_USAGE,
        inputTokens: 12,
        outputTokens: 3,
        costMicroUsd: 51,
        priceVersion: "2026-10-26",
      },
    });

    const msgs = await listMessages(db, t, thread.id);
    expect(msgs.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "2+2?", "complete"],
      ["assistant", "4", "complete"],
    ]);
    expect(msgs[1]?.parentId).toBe(q);
    expect(msgs[1]?.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, costMicroUsd: 51 });
    expect((await getThread(db, t, thread.id))?.costMicroUsd).toBe(51);

    const log = await listRecentRequests(db, t);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ purpose: "chat", messageId: a, providerRequestId: "req_test" });
  });

  test("answers left streaming by a crash are marked interrupted", async () => {
    const db = openTestDb();
    const thread = await createThread(db, t);
    await addMessage(db, t, {
      threadId: thread.id,
      parentId: null,
      role: "assistant",
      content: "par",
      status: "streaming",
    });
    expect(await markInterruptedMessages(db, t)).toBe(1);
    expect((await listMessages(db, t, thread.id))[0]).toMatchObject({
      status: "stopped",
      errorCode: "interrupted",
    });
  });

  test("a message must belong to an existing thread", async () => {
    const db = openTestDb();
    await expect(
      addMessage(db, t, { threadId: "missing", parentId: null, role: "user", content: "x" }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});
