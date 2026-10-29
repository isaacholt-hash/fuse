// @vitest-environment node
// PM-19: the two-provider continuity test, automated part. Each recorded project history is built
// as FUSE holds it, then a question goes to the real OpenAI and Anthropic adapters (replaying a
// recorded response, no API calls). Every critical decision and constraint must be in both
// requests, even with the history summarized and the memory budget crowded.
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { sendMessage } from "@/chat/sendMessage";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { fakeFetch } from "@/providers/testing/fakeFetch";
import { loadFixture } from "@/providers/testing/fixtures";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import { answerPasses, buildScenario, loadScenarios } from "./testing/continuity";

const t = DEFAULT_TENANT;
const model = (provider: "anthropic" | "openai", id: string) => ({
  provider,
  id,
  display_name: id,
  context_window: 200000,
  max_output: 4000,
  price: { input: 1, output: 4 },
  capabilities: [],
  verified_on: "2026-10-29",
  source_url: "https://example.com",
});
const catalog = parseCatalog({
  price_version: "2026-10-29",
  models: [model("anthropic", "test-claude"), model("openai", "test-gpt")],
});
const MODELS = {
  anthropic: catalog.models[0] as CatalogModel,
  openai: catalog.models[1] as CatalogModel,
};

const scenarios = loadScenarios();

test("the benchmark has real scenarios: decisions, constraints and a question for each", () => {
  expect(scenarios.length).toBeGreaterThanOrEqual(3);
  for (const s of scenarios) {
    const critical = new Set(s.questions.map((q) => q.critical));
    for (const d of s.decisions) expect(critical, `${s.id}: ${d.id}`).toContain(d.id);
    for (const c of s.constraints) expect(critical, `${s.id}: ${c.id}`).toContain(c.id);
  }
});

describe.each(scenarios.map((s) => [s.id, s] as const))("%s", (_id, scenario) => {
  test.each(["anthropic", "openai"] as const)(
    "every decision and constraint reaches %s, summarized history and crowded memory or not",
    async (provider) => {
      for (const crowded of [false, true]) {
        const db = openTestDb();
        const { threadId } = await buildScenario(db, t, scenario, { crowded });
        const fake = fakeFetch(
          scenario.questions.map(() => loadFixture(provider, "text").response),
        );
        const adapter =
          provider === "openai"
            ? createOpenAIAdapter({ fetch: fake.fetch })
            : createAnthropicAdapter({ fetch: fake.fetch });
        const deps = { db, tenant: t, catalog, adapterFor: () => adapter };
        for (const q of scenario.questions) {
          await sendMessage(deps, { threadId, text: q.ask, model: MODELS[provider] });
        }
        expect(fake.sent).toHaveLength(scenario.questions.length);
        for (const sent of fake.sent) {
          const body = JSON.stringify(sent.body);
          for (const d of scenario.decisions) {
            expect(body, `${provider} ${d.id}`).toContain(JSON.stringify(d.text).slice(1, -1));
            expect(body).toContain(JSON.stringify(d.rationale).slice(1, -1));
          }
          for (const c of scenario.constraints) {
            expect(body, `${provider} ${c.id}`).toContain(JSON.stringify(c.text).slice(1, -1));
          }
          for (const task of scenario.tasks) expect(body).toContain(task);
          expect(body).toContain(JSON.stringify(scenario.project.instructions).slice(1, -1));
          if (scenario.summary) {
            expect(body).toContain(JSON.stringify(scenario.summary).slice(1, -1));
          }
        }
      }
    },
  );
});

test("answers are scored by their expected terms, any spelling given", () => {
  expect(answerPasses("We chose Solid OAK worktops.", ["oak"])).toBe(true);
  expect(answerPasses("The budget is £8k.", ["8,000|8000|8k"])).toBe(true);
  expect(answerPasses("Go with quartz.", ["oak"])).toBe(false);
  expect(answerPasses("Train to Alfama", ["train", "alfama"])).toBe(true);
});
