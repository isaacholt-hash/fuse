// @vitest-environment node
import { addMessage } from "@/storage/messages";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addFile } from "@/storage/files";
import { logRequest } from "@/storage/requestLog";
import { addToolStep, createRun, setRunStatus } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { EMPTY_USAGE } from "@/storage/usage";
import { replaceChunks, saveVectors } from "@/storage/vectors";
import type { StorageSizes } from "./backups";
import {
  cleanUp,
  clearVectors,
  formatBytes,
  storageReport,
  trimRequestLog,
  trimRunOutput,
} from "./storage";

const t = DEFAULT_TENANT;
const DAY = 86_400_000;
const sizes: StorageSizes = {
  databaseBytes: 3 * 1024 * 1024,
  backupCount: 4,
  backupBytes: 12 * 1024 * 1024,
  attachmentCount: 3,
  attachmentBytes: 500_000,
};

test("bytes read as people write them", () => {
  expect(formatBytes(900)).toBe("900 B");
  expect(formatBytes(4096)).toBe("4.0 KB");
  expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  expect(formatBytes(120 * 1024 * 1024)).toBe("120 MB");
  expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
});

test("the report names each part, and offers a clean-up only where there's something to clean", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const q = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "user",
    content: "hi",
  });
  await addFile(db, t, { name: "a", mime: "text/plain", sizeBytes: 1, sha256: "a".repeat(64) });
  await logRequest(db, t, {
    threadId: thread.id,
    messageId: q,
    purpose: "chat",
    provider: "anthropic",
    model: "m",
    attempt: 1,
    usage: EMPTY_USAGE,
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    providerRequestId: null,
  });
  const rows = await storageReport(db, t, { sizes: () => Promise.resolve(sizes) });
  expect(rows.map((r) => [r.id, r.count, r.cleanup !== null])).toEqual([
    ["database", 1, false],
    ["attachments", 3, true], // 3 files on disk, 1 named by the database
    ["vectors", 0, false],
    ["backups", 4, true],
    ["requestLog", 1, false], // nothing older than 90 days
    ["runOutput", 0, false],
  ]);
  expect(rows[1]?.cleanup).toBe("Remove 2 files no chat or project names any more");
  expect(rows[0]?.bytes).toBe(3 * 1024 * 1024);
});

test("trimming the request log keeps the last 90 days and unlinks what pointed at older rows", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const q = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "user",
    content: "hi",
  });
  const entry = {
    threadId: thread.id,
    messageId: q,
    purpose: "chat" as const,
    provider: "anthropic",
    model: "m",
    attempt: 1,
    usage: { ...EMPTY_USAGE, costMicroUsd: 5 },
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    providerRequestId: null,
  };
  const old = await logRequest(db, t, entry);
  const fresh = await logRequest(db, t, entry);
  const now = Date.now();
  await db.execute("UPDATE request_log SET created_at = ? WHERE id = ?", [now - 100 * DAY, old]);
  await db.execute("UPDATE messages SET request_id = ? WHERE id = ?", [old, q]);
  expect(await trimRequestLog(db, t, now)).toBe(1);
  expect(await db.select("SELECT id FROM request_log")).toEqual([{ id: fresh }]);
  expect(await db.select("SELECT request_id AS r FROM messages WHERE id = ?", [q])).toEqual([
    { r: null },
  ]);
  expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("clearing embeddings keeps the chunks; old finished runs lose their tool output, going ones keep it", async () => {
  const db = openTestDb();
  await replaceChunks(db, t, "file", "f1", [{ ordinal: 0, text: "apple boat", tokens: 2 }]);
  const chunk = (await db.select<{ id: string }>("SELECT id FROM chunks"))[0]?.id ?? "";
  await saveVectors(db, t, "embed", [{ chunkId: chunk, vector: new Float32Array([1, 0]) }]);
  expect(await clearVectors(db, t)).toBe(1);
  expect(await db.select("SELECT COUNT(*) AS n FROM chunks")).toEqual([{ n: 1 }]);

  const now = Date.now();
  const make = async (status: "done" | "running", ago: number) => {
    const run = await createRun(db, t, {
      projectId: null,
      threadId: null,
      messageId: null,
      task: "x",
      provider: "anthropic",
      model: "m",
      capMicroUsd: 1,
    });
    await addToolStep(db, t, run.id, {
      call: { id: "c1", name: "read_file", input: { path: "a" } },
      output: "a".repeat(1000),
      isError: false,
    });
    if (status === "done") await setRunStatus(db, t, run.id, "done", null);
    await db.execute("UPDATE runs SET updated_at = ? WHERE id = ?", [now - ago, run.id]);
    return run.id;
  };
  const old = await make("done", 40 * DAY);
  const recent = await make("done", 2 * DAY);
  const going = await make("running", 40 * DAY);
  expect(await trimRunOutput(db, t, now)).toBe(1);
  const outputs = await db.select<{ run_id: string; output: string }>(
    "SELECT run_id, output FROM run_steps ORDER BY run_id",
  );
  const by = new Map(outputs.map((o) => [o.run_id, o.output]));
  expect(by.get(old)).toBe("(output removed to save space)");
  expect(by.get(recent)?.length).toBe(1000);
  expect(by.get(going)?.length).toBe(1000);
  // Running it again finds nothing more.
  expect(await trimRunOutput(db, t, now)).toBe(0);
  expect(
    await cleanUp(
      db,
      t,
      { pruneFiles: () => Promise.resolve(2), pruneBackups: () => Promise.resolve(3) },
      "backups",
    ),
  ).toBe("Removed 3 backups.");
  expect(
    await cleanUp(
      db,
      t,
      {
        pruneFiles: (keep) => Promise.resolve(keep.length),
        pruneBackups: () => Promise.resolve(0),
      },
      "attachments",
    ),
  ).toBe("Removed 0 files.");
});
