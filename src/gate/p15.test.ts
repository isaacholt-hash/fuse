// @vitest-environment node
// M7 step 13: the P1.5 gate (requirements §3). On the shipped routing test set, cost per
// successful task with M7 (fixed rules, local housekeeping, the cache) is below the cloud-only
// baseline with no drop in quality, and a Local only project makes no cloud call.
//
// One workload runs twice through the real send, routing, housekeeping and cache code: the
// routing test set (each prompt a new chat), five sums and conversions, and five questions asked
// again in a new chat. Cloud models are fakes that answer with fixed text and token counts
// (priced from data/models.json); the second opinion they give is the test set's own label. The
// local model is scripted: it gives the same labels, except for one unreadable reply in ten.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import type { CatalogModel } from "@/catalog/catalog";
import { housekeepingModel } from "@/chat/housekeeping";
import { sendMessage, sendWithoutModel, type ChatDeps } from "@/chat/sendMessage";
import { autoTitle, TITLE_SYSTEM } from "@/chat/title";
import { economics, taskSucceeded } from "@/cost/economics";
import { answerWithoutModel } from "@/deterministic/handlers";
import { localCatalogModel, localModels } from "@/local/models";
import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from "@/providers/types";
import { scriptedLocal } from "@/providers/local/scripted";
import { classify } from "@/routing/classify";
import { checkClassification, CLASSIFY_SYSTEM } from "@/routing/classifyFallback";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { parseGoldenSet, type GoldenPrompt } from "@/routing/golden";
import { chooseTier } from "@/routing/policy";
import { AUTO, route } from "@/routing/route";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectPrivacy } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import type { SqlDb } from "@/storage/sql";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { spentSince } from "@/storage/budgets";
import { cloudCallsAvoidedSince, listQuestionTasks } from "@/storage/usageReport";

const t = DEFAULT_TENANT;
const ROOT = join(import.meta.dirname, "..", "..");
const parsed = parseGoldenSet(
  readFileSync(join(ROOT, "data", "routing-test", "prompts.jsonl"), "utf8"),
);
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const golden: GoldenPrompt[] = parsed.prompts.filter((p) => !p.needsContext);
const label = new Map(
  golden.map((p) => [p.prompt, { intent: p.intent, complexity: p.complexity }]),
);

const FIXED = [
  "what is 18% of 2,450?",
  "convert 12 miles to km",
  "how many days between 2026-11-01 and 2026-12-25",
  'is this valid json: {"a": [1, 2]}',
  "1024 * 768",
];
const REPEATS = golden
  .filter((p) => p.complexity !== "high")
  .slice(0, 5)
  .map((p) => p.prompt);
const WORKLOAD = [...golden.map((p) => p.prompt), ...FIXED, ...REPEATS];

const labelJson = (q: string) => {
  const l = label.get(q.trim());
  return JSON.stringify(l ?? { intent: "chat", complexity: "low" });
};

/** The cloud: answers, titles and second opinions, with realistic token counts. */
function fakeCloud() {
  const calls: { provider: string; system: string }[] = [];
  const make = (provider: "anthropic" | "openai"): ProviderAdapter => ({
    provider,
    listModels: () => Promise.resolve([]),
    async *streamChat(messages: ChatMessage[], _model: string, options: ChatOptions) {
      calls.push({ provider, system: options.system ?? "" });
      await Promise.resolve();
      const input = messages.map((m) => m.content).join("\n");
      const housekeeping = options.system === CLASSIFY_SYSTEM || options.system === TITLE_SYSTEM;
      const text =
        options.system === CLASSIFY_SYSTEM
          ? labelJson(input)
          : options.system === TITLE_SYSTEM
            ? "A short title"
            : `An answer to: ${input.slice(0, 40)}`;
      const events: StreamEvent[] = [
        { type: "text", text },
        {
          type: "done",
          usage: {
            inputTokens: Math.ceil(input.length / 4) + (housekeeping ? 120 : 900),
            outputTokens: housekeeping ? 12 : 450,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            webSearchCalls: 0,
          },
          usageReported: true,
          stopReason: "end_turn",
          providerRequestId: null,
          attempts: 1,
        },
      ];
      yield* events;
    },
  });
  return { anthropic: make("anthropic"), openai: make("openai"), calls };
}

const profile = localModels.profiles.at(-1);
if (!profile) throw new Error("no local profile");
const localModel: CatalogModel = localCatalogModel(profile, localModels.verifiedOn);

/** The local model: the same labels as the cloud, but one unreadable reply in ten. */
function fakeLocal() {
  let n = 0;
  const reply = (messages: ChatMessage[]) => {
    n++;
    const input = messages[0]?.content ?? "";
    if (input.startsWith("<user_message>")) return "Local title";
    return n % 10 === 0 ? "Hmm, hard to say!" : labelJson(input);
  };
  return scriptedLocal([], reply);
}

interface Run {
  db: SqlDb;
  tiers: Map<string, string>;
  cloudCalls: number;
}

async function runWorkload(withM7: boolean, projectId: string | null = null, db = openTestDb()) {
  const cloud = fakeCloud();
  const local = fakeLocal();
  const providers = ["anthropic", "openai"] as const;
  const deps: ChatDeps = {
    db,
    tenant: t,
    catalog: defaultCatalog,
    adapterFor: (p) => (p === "local" ? local.adapter : cloud[p]),
    ...(withM7 ? { local: localModel } : { local: null, cache: false }),
  };
  const tiers = new Map<string, string>();
  for (const text of WORKLOAD) {
    const thread = await createThread(db, t, "New chat", projectId);
    // LL-01: a fixed rule first.
    const fixed = withM7 ? answerWithoutModel(text, Date.UTC(2026, 9, 30, 12)) : null;
    if (fixed) {
      await sendWithoutModel(deps, { threadId: thread.id, text, answer: fixed });
      continue;
    }
    // RT-02: the heuristics, and a second opinion when they're unsure.
    let task = classify({ text });
    if (task.unsure) {
      const helper = housekeepingModel(defaultPolicy, defaultCatalog, "classify", [...providers]);
      if (helper)
        task = await checkClassification(deps, defaultCatalog, helper, task, text, thread.id);
    }
    tiers.set(text, chooseTier(defaultPolicy, task).tier);
    const routed = route(defaultPolicy, defaultCatalog, AUTO, task, { providers: [...providers] });
    if (!routed.ok) throw new Error(routed.error);
    await sendMessage(deps, { threadId: thread.id, model: routed.model, text, route: routed.info });
    const titler = housekeepingModel(defaultPolicy, defaultCatalog, "title", [...providers]);
    if (titler) await autoTitle(deps, defaultCatalog, thread.id, titler);
  }
  return { db, tiers, cloudCalls: cloud.calls.length } satisfies Run;
}

async function score(run: Run) {
  const tasks = await listQuestionTasks(run.db, t, 0);
  const e = economics(
    tasks,
    await spentSince(run.db, t, 0),
    await cloudCallsAvoidedSince(run.db, t, 0),
  );
  const right = golden.filter((p) => run.tiers.get(p.prompt) === p.expectedTier).length;
  return { ...e, tierRight: right, allSucceeded: tasks.every(taskSucceeded) };
}

test("P1.5 gate: cost per successful task falls, with no quality drop on the routing test set", async () => {
  const baseline = await score(await runWorkload(false));
  const m7Run = await runWorkload(true);
  const m7 = await score(m7Run);
  console.table([
    {
      run: "cloud only",
      ...baseline,
      perSuccess: `$${((baseline.perSuccess ?? 0) / 1e6).toFixed(4)}`,
    },
    { run: "with M7", ...m7, perSuccess: `$${((m7.perSuccess ?? 0) / 1e6).toFixed(4)}` },
  ]);
  // Same work done: every task succeeded in both runs.
  expect(baseline.tasks).toBe(WORKLOAD.length);
  expect(m7.tasks).toBe(WORKLOAD.length);
  expect(baseline.allSucceeded && m7.allSucceeded).toBe(true);
  // Quality: the routing test set picks the expected tier at least as often (local second
  // opinions, with one unreadable in ten falling back to the cloud).
  expect(m7.tierRight).toBeGreaterThanOrEqual(baseline.tierRight);
  // The same tier for every routed prompt, so answers come from the same models.
  const baselineTiers = (await runWorkload(false)).tiers;
  for (const [prompt, tier] of m7Run.tiers) expect(tier, prompt).toBe(baselineTiers.get(prompt));
  // Cost: lower per successful task, with cloud calls avoided.
  expect(m7.perSuccess).not.toBeNull();
  expect(m7.perSuccess ?? Infinity).toBeLessThan(baseline.perSuccess ?? 0);
  expect(m7.cloudCallsAvoided).toBeGreaterThan(0);
  expect(baseline.cloudCallsAvoided).toBe(0);
});

test("P1.5 gate: a Local only project makes no cloud call", async () => {
  const db = openTestDb();
  const project = await createProject(db, t, "Private");
  await setProjectPrivacy(db, t, project.id, { mode: "local_only", allowEmbeddings: false });
  const run = await runWorkload(true, project.id, db);
  expect(run.cloudCalls).toBe(0);
  // Fixed-rule answers still worked; every other answer was refused before anything was sent.
  const rows = await listRecentRequests(db, t, 1000);
  const answered = rows.filter((r) => r.errorCode === null);
  expect(answered.every((r) => r.provider === "deterministic" || r.provider === "local")).toBe(
    true,
  );
  expect(answered.some((r) => r.provider === "deterministic")).toBe(true);
});
