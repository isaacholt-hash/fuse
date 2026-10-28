// @vitest-environment node
import { DEFAULT_TENANT } from "./defaults";
import {
  addBudget,
  allowBudgetUntil,
  deleteBudget,
  listBudgets,
  recordAlert,
  spentSince,
} from "./budgets";
import { logRequest } from "./requestLog";
import { createProject } from "./projects";
import { openTestDb } from "./testing/nodeDb";
import { createThread } from "./threads";
import { EMPTY_USAGE } from "./usage";

const t = DEFAULT_TENANT;

test("budgets, spend per project, alerts once per period", async () => {
  const db = openTestDb();
  const project = await createProject(db, t, "Work");
  const inProject = await createThread(db, t, "x", project.id);
  const loose = await createThread(db, t, "y");
  for (const [threadId, cost] of [
    [inProject.id, 3000],
    [loose.id, 5000],
    [null, 100],
  ] as const) {
    await logRequest(db, t, {
      threadId,
      messageId: null,
      purpose: "chat",
      provider: "openai",
      model: "m",
      attempt: 1,
      usage: { ...EMPTY_USAGE, costMicroUsd: cost },
      httpStatus: 200,
      errorCode: null,
      errorMessage: null,
      providerRequestId: null,
    });
  }
  expect(await spentSince(db, t, 0)).toBe(8100);
  expect(await spentSince(db, t, 0, project.id)).toBe(3000);
  expect(await spentSince(db, t, Date.now() + 60_000)).toBe(0);

  const id = await addBudget(db, t, {
    projectId: project.id,
    period: "day",
    limitMicro: 5000,
    hardStop: true,
  });
  await allowBudgetUntil(db, t, id, 123);
  expect(await listBudgets(db, t)).toEqual([
    { id, projectId: project.id, period: "day", limitMicro: 5000, hardStop: true, allowUntil: 123 },
  ]);
  expect(await recordAlert(db, t, id, "50", 1)).toBe(true);
  expect(await recordAlert(db, t, id, "50", 1)).toBe(false);
  expect(await recordAlert(db, t, id, "50", 2)).toBe(true);
  expect(await recordAlert(db, t, null, "anomaly", 1)).toBe(true);
  expect(await recordAlert(db, t, null, "anomaly", 1)).toBe(false);
  await deleteBudget(db, t, id);
  expect(await listBudgets(db, t)).toEqual([]);
});
