// @vitest-environment node
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { messageViews } from "@/app/viewModels";
import { answerWithoutModel } from "@/deterministic/handlers";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listPath } from "@/storage/messages";
import { listRecentRequests } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, getThread } from "@/storage/threads";
import { cloudCallsAvoidedSince } from "@/storage/usageReport";
import { sendWithoutModel, type ChatDeps } from "./sendMessage";

const t = DEFAULT_TENANT;

test("LL-01: a fixed-rule answer is saved, titled, logged at $0 and calls no provider", async () => {
  const db = openTestDb();
  const deps: ChatDeps = {
    db,
    tenant: t,
    catalog: defaultCatalog,
    adapterFor: () => {
      throw new Error("no provider may be called");
    },
  };
  const thread = await createThread(db, t);
  const answer = answerWithoutModel("what is 12 * 7?", Date.now());
  if (!answer) throw new Error("expected a fixed-rule answer");
  const r = await sendWithoutModel(deps, { threadId: thread.id, text: "what is 12 * 7?", answer });
  expect(r).toMatchObject({ status: "complete", costMicroUsd: 0 });

  const { path } = await listPath(db, t, thread.id);
  expect(path.map((m) => [m.role, m.content, m.provider])).toEqual([
    ["user", "what is 12 * 7?", null],
    ["assistant", "12 * 7 = 84", "deterministic"],
  ]);
  expect((await getThread(db, t, thread.id))?.title).toBe("what is 12 * 7?");
  const logged = await listRecentRequests(db, t);
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({
    provider: "deterministic",
    model: "arithmetic",
    purpose: "chat",
  });
  expect(logged[0]?.usage.costMicroUsd).toBe(0);
  expect(await cloudCallsAvoidedSince(db, t, 0)).toBe(1);

  const [, view] = messageViews(path, defaultCatalog);
  expect(view).toMatchObject({ noModel: "Arithmetic", model: "No model" });
  expect(view?.usage).toBeUndefined();
});
