import { expect, test } from "vitest";
import { DEFAULT_TENANT } from "./defaults";
import {
  addMemory,
  addProposals,
  approveProposal,
  deleteMemory,
  deviceId,
  editMemory,
  listMemories,
  listPendingProposals,
} from "./memories";
import { createProject } from "./projects";
import { createThread } from "./threads";
import { openTestDb } from "./testing/nodeDb";

const t = DEFAULT_TENANT;

test("typed records carry scope, authority, status and the device that made them (PM-12 to PM-14)", async () => {
  const db = openTestDb();
  const project = await createProject(db, t, "Garden");
  const thread = await createThread(db, t);
  await addMemory(db, t, { text: "Budget is £500.", kind: "constraint", projectId: project.id });
  await addMemory(db, t, { text: "Use the blue pots.", kind: "preference", threadId: thread.id });
  const [constraint, chatOnly] = await listMemories(db, t);
  expect(constraint).toMatchObject({
    kind: "constraint",
    scope: "project",
    authority: "you",
    status: "active",
    maySend: true,
    revision: 1,
  });
  expect(chatOnly).toMatchObject({ scope: "conversation", threadId: thread.id });
  const [row] = await db.select<{ device_id: string }>("SELECT device_id FROM memories LIMIT 1");
  expect(row?.device_id).toBe(await deviceId(db, t));
  expect(await deviceId(db, t)).toBe(row?.device_id);
});

test("an edit makes a record yours and bumps its revision; a delete keeps it as status deleted", async () => {
  const db = openTestDb();
  await addProposals(db, t, [
    {
      op: "add",
      memoryId: null,
      text: "Likes jazz.",
      kind: "preference",
      projectId: null,
      confidence: 70,
      sourceThreadId: null,
      extractionModel: "cheap-model",
    },
  ]);
  const [p] = await listPendingProposals(db, t);
  await approveProposal(db, t, p?.id ?? "");
  const [imported] = await listMemories(db, t);
  expect(imported).toMatchObject({
    authority: "imported",
    extractionMethod: "import",
    extractionModel: "cheap-model",
  });
  await editMemory(db, t, imported?.id ?? "", {
    text: "Likes cool jazz.",
    kind: "preference",
    projectId: null,
  });
  expect((await listMemories(db, t))[0]).toMatchObject({ authority: "you", revision: 2 });
  await deleteMemory(db, t, imported?.id ?? "");
  expect(await listMemories(db, t)).toEqual([]);
  const [gone] = await db.select<{ status: string }>("SELECT status FROM memories");
  expect(gone?.status).toBe("deleted");
});

test("expired and excluded records are not in use", async () => {
  const db = openTestDb();
  const a = await addMemory(db, t, { text: "Staying in Rome this week.", kind: "fact" });
  const b = await addMemory(db, t, { text: "Prefers tea.", kind: "preference" });
  await addMemory(db, t, { text: "Lives in Leeds.", kind: "fact" });
  await db.execute("UPDATE memories SET expires_at = 1 WHERE id = ?", [a]);
  await db.execute("UPDATE memories SET status = 'excluded' WHERE id = ?", [b]);
  expect((await listMemories(db, t)).map((m) => m.text)).toEqual(["Lives in Leeds."]);
});
