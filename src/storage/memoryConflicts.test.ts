// @vitest-environment node
import { DEFAULT_TENANT } from "./defaults";
import {
  addMemory,
  addProposals,
  approveProposal,
  conflictWith,
  listMemories,
  listPendingProposals,
  listReplaced,
  restoreMemory,
  type Memory,
} from "./memories";
import { openTestDb } from "./testing/nodeDb";

const t = DEFAULT_TENANT;
const mem = (text: string, category: Memory["category"] = "fact"): Memory => ({
  id: text,
  text,
  category,
  projectId: null,
  sourceThreadId: null,
  sourceThreadTitle: null,
  confidence: 100,
  createdAt: 0,
  updatedAt: 0,
});

test("a new fact about the same thing is a possible conflict; other facts aren't", () => {
  const saved = [mem("Lives in Leeds"), mem("Prefers short answers", "preference")];
  expect(conflictWith(saved, "Lives in York", "fact")?.text).toBe("Lives in Leeds");
  expect(conflictWith(saved, "Prefers metric units", "preference")).toBeNull();
  expect(conflictWith(saved, "lives in leeds", "fact")).toBeNull(); // the same fact
  expect(conflictWith(saved, "Lives in York", "person")).toBeNull(); // another kind
});

test("keeping the new one keeps the old as history, and it can be restored", async () => {
  const db = openTestDb();
  const old = await addMemory(db, t, {
    text: "Lives in Leeds",
    category: "fact",
    projectId: null,
    sourceThreadId: null,
    confidence: 100,
  });
  await addProposals(db, t, [
    {
      op: "add",
      memoryId: null,
      text: "Lives in York",
      category: "fact",
      projectId: null,
      confidence: 90,
      sourceThreadId: null,
    },
  ]);
  const [p] = await listPendingProposals(db, t);
  if (!p) throw new Error("no proposal");
  await approveProposal(db, t, p.id, undefined, old);
  expect((await listMemories(db, t)).map((m) => m.text)).toEqual(["Lives in York"]);
  expect(await listReplaced(db, t)).toMatchObject([
    { id: old, text: "Lives in Leeds", newer: "Lives in York" },
  ]);
  await restoreMemory(db, t, old);
  expect((await listMemories(db, t)).map((m) => m.text)).toEqual(["Lives in Leeds"]);
  expect(await listReplaced(db, t)).toMatchObject([
    { text: "Lives in York", newer: "Lives in Leeds" },
  ]);
});
