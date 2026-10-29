// @vitest-environment node
import { fakeMemory } from "@/storage/testing/memory";
import { selectMemories } from "@/memory/inject";
import type { Memory } from "@/storage/memories";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addMessage } from "@/storage/messages";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { isRecallQuestion, recallPastChats } from "./recall";

const t = DEFAULT_TENANT;

test("recall questions are spotted; ordinary ones aren't", () => {
  for (const q of [
    "What did we decide about the database?",
    "Remind me what we said about Lisbon",
    "Last week we talked about a budget, what was it?",
    "Did we ever discuss sqlite-vec?",
  ]) {
    expect(isRecallQuestion(q), q).toBe(true);
  }
  for (const q of ["What is a database?", "Plan a trip to Lisbon"]) {
    expect(isRecallQuestion(q), q).toBe(false);
  }
});

test("past chats on the topic come back with their titles and dates, not this chat", async () => {
  const db = openTestDb();
  const boat = await createThread(db, t, "Boat plans");
  const q = await addMessage(db, t, {
    threadId: boat.id,
    parentId: null,
    role: "user",
    content: "Which harbour for the boat?",
  });
  await addMessage(db, t, {
    threadId: boat.id,
    parentId: q,
    role: "assistant",
    content: "We settled on the north harbour: cheaper mooring.",
  });
  const other = await createThread(db, t, "Cooking");
  await addMessage(db, t, {
    threadId: other.id,
    parentId: null,
    role: "user",
    content: "Pasta tonight?",
  });
  const here = await createThread(db, t, "Now");
  await addMessage(db, t, {
    threadId: here.id,
    parentId: null,
    role: "user",
    content: "harbour harbour",
  });

  const r = await recallPastChats(
    { db, tenant: t },
    "What did we decide about the harbour?",
    here.id,
  );
  expect(r?.text).toContain("We settled on the north harbour");
  expect(r?.text).toContain('title="Boat plans"');
  expect(r?.sources.map((s) => s.label)).toEqual([expect.stringMatching(/^Chat: Boat plans \(/)]);
  expect(
    await recallPastChats({ db, tenant: t }, "What did we decide last week?", here.id),
  ).toBeNull();
});

test("memories past the budget: meaning lifts a memory that shares no words", () => {
  const mem = (id: string, text: string): Memory => fakeMemory({ id, text });
  const pool = [mem("kid", "Has a girl, Maya, aged 7."), mem("car", "Drives a 2026 VW Atlas.")];
  const budget = 12; // room for one
  expect(
    selectMemories(
      pool,
      "what should my daughter read",
      { projectId: null, threadId: null },
      budget,
    ),
  ).toEqual([]);
  expect(
    selectMemories(
      pool,
      "what should my daughter read",
      { projectId: null, threadId: null },
      budget,
      new Map([
        ["kid", 0.7],
        ["car", 0.1],
      ]),
    ),
  ).toEqual([pool[0]]);
});
