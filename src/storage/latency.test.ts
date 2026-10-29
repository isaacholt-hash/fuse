// @vitest-environment node
import { DEFAULT_TENANT } from "./defaults";
import { logRequest, medianFirstTokenMs } from "./requestLog";
import { openTestDb } from "./testing/nodeDb";
import { EMPTY_USAGE } from "./usage";

test("median time to first token per model, from successful chat answers, three or more", async () => {
  const db = openTestDb();
  const log = (model: string, ttftMs: number, purpose: "chat" | "title" = "chat", error = false) =>
    logRequest(db, DEFAULT_TENANT, {
      threadId: null,
      messageId: null,
      purpose,
      provider: "anthropic",
      model,
      attempt: 1,
      usage: { ...EMPTY_USAGE, ttftMs },
      httpStatus: error ? 500 : 200,
      errorCode: error ? "server" : null,
      errorMessage: null,
      providerRequestId: null,
    });
  for (const t of [300, 500, 400, 900]) await log("a", t);
  await log("a", 50, "title");
  await log("a", 10, "chat", true);
  for (const t of [700, 800]) await log("b", t);
  expect(await medianFirstTokenMs(db, DEFAULT_TENANT, 0)).toEqual({ "anthropic/a": 450 });
});
