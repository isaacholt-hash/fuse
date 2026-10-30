// @vitest-environment node
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addMessage, finishMessage, setFeedback } from "@/storage/messages";
import { logRequest } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { EMPTY_USAGE } from "@/storage/usage";
import { cloudCallsAvoidedSince, listQuestionTasks } from "@/storage/usageReport";
import {
  againstBaseline,
  economics,
  parseBaseline,
  taskSucceeded,
  type TaskRecord,
} from "./economics";

const t = DEFAULT_TENANT;
const done = { status: "complete", feedback: null } as const;

test("a task succeeds on its newest answer, unless edited or marked bad", () => {
  expect(taskSucceeded({ answers: [done], edited: false })).toBe(true);
  // A regenerate that ended well: one task, succeeded.
  expect(taskSucceeded({ answers: [{ ...done, feedback: "down" }, done], edited: false })).toBe(
    true,
  );
  expect(taskSucceeded({ answers: [done, { ...done, feedback: "down" }], edited: false })).toBe(
    false,
  );
  expect(taskSucceeded({ answers: [{ status: "error", feedback: null }], edited: false })).toBe(
    false,
  );
  expect(taskSucceeded({ answers: [done], edited: true })).toBe(false);
  expect(taskSucceeded({ answers: [], edited: false })).toBe(false);
});

test("all spend divided by the tasks that succeeded", () => {
  const tasks: TaskRecord[] = [
    { answers: [done], edited: false },
    { answers: [done], edited: false },
    { answers: [{ status: "error", feedback: null }], edited: false },
  ];
  expect(economics(tasks, 9000, 2)).toEqual({
    tasks: 3,
    succeeded: 2,
    spent: 9000,
    perSuccess: 4500,
    cloudCallsAvoided: 2,
  });
  expect(economics([], 500, 0).perSuccess).toBeNull();
});

test("the baseline: stored as JSON, compared in percent", () => {
  const b = { at: 1, days: 30, tasks: 10, succeeded: 8, perSuccess: 2000 };
  expect(parseBaseline(JSON.stringify(b))).toEqual(b);
  expect(parseBaseline("{")).toBeNull();
  expect(parseBaseline(JSON.stringify({ at: 1 }))).toBeNull();
  expect(againstBaseline(1500, b)).toBe(-25);
  expect(againstBaseline(null, b)).toBeNull();
  expect(againstBaseline(1500, null)).toBeNull();
});

test("tasks from the database: regenerates, edits, feedback and calls avoided", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t, "x");
  const ask = (parentId: string | null) =>
    addMessage(db, t, { threadId: thread.id, parentId, role: "user", content: "q" });
  const answer = async (parentId: string, status: "complete" | "error" = "complete") => {
    const id = await addMessage(db, t, {
      threadId: thread.id,
      parentId,
      role: "assistant",
      content: "",
      status: "streaming",
    });
    await finishMessage(db, t, id, { content: "a", status });
    return id;
  };
  // Question 1, asked then edited: the first version is redone.
  const q1 = await ask(null);
  await answer(q1);
  const q1b = await ask(null);
  const a1b = await answer(q1b);
  // Question 2: a failed answer, then a regenerate that worked.
  const q2 = await ask(a1b);
  await answer(q2, "error");
  const a2 = await answer(q2);
  // Question 3: answered, marked bad.
  const q3 = await ask(a2);
  const a3 = await answer(q3);
  await setFeedback(db, t, a3, "down");

  const tasks = await listQuestionTasks(db, t, 0);
  expect(tasks.map(taskSucceeded)).toEqual([false, true, true, false]);
  expect(tasks.map((x) => x.edited)).toEqual([true, false, false, false]);
  expect(tasks[2]?.answers.map((a) => a.status)).toEqual(["error", "complete"]);

  for (const provider of ["local", "deterministic", "openai"]) {
    await logRequest(db, t, {
      threadId: thread.id,
      messageId: null,
      purpose: "title",
      provider,
      model: "m",
      attempt: 1,
      usage: EMPTY_USAGE,
      httpStatus: null,
      errorCode: null,
      errorMessage: null,
      providerRequestId: null,
    });
  }
  expect(await cloudCallsAvoidedSince(db, t, 0)).toBe(2);
});
