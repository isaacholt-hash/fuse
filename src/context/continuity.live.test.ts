// @vitest-environment node
// PM-19, the live half: the continuity benchmark against the real OpenAI and Anthropic APIs.
// Skipped in `pnpm test`. Isaac runs it with keys from his own shell, never from a file:
//
//   FUSE_OPENAI_API_KEY=… FUSE_ANTHROPIC_API_KEY=… pnpm continuity:live
//
// (or with both already exported; a provider without a key is skipped). Keys are only ever put
// in the request's auth header; they're never printed or written anywhere.
// Models: each provider's cheapest Balanced model from data/, or FUSE_CONTINUITY_OPENAI_MODEL /
// FUSE_CONTINUITY_ANTHROPIC_MODEL. Cost: about 30 short requests, a few cents in all.
// Gate: each provider keeps at least 90% of the critical decisions and constraints.
import { defaultCatalog } from "@/catalog/defaultCatalog";
import {
  findModel,
  type CatalogModel,
  type CloudProviderId,
  type ProviderId,
} from "@/catalog/catalog";
import { sendMessage } from "@/chat/sendMessage";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { SCOPE_HEADER, type FetchLike } from "@/providers/types";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { tierModels } from "@/routing/policy";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listMessages } from "@/storage/messages";
import { openTestDb } from "@/storage/testing/nodeDb";
import { answerPasses, buildScenario, loadScenarios } from "./testing/continuity";

const LIVE = import.meta.env.MODE === "continuity";
const KEYS: Record<CloudProviderId, string | undefined> = {
  openai: process.env.FUSE_OPENAI_API_KEY,
  anthropic: process.env.FUSE_ANTHROPIC_API_KEY,
};
const GATE = 0.9;

/** Real fetch with the key added; FUSE's internal scope header stays here. */
function keyedFetch(provider: ProviderId, key: string): FetchLike {
  return async (url, init) => {
    const { [SCOPE_HEADER]: _scope, ...headers } = init.headers;
    const auth: Record<string, string> =
      provider === "openai" ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
    return fetch(url, {
      method: init.method,
      headers: { ...headers, ...auth },
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
}

function modelFor(provider: ProviderId): CatalogModel | undefined {
  const chosen =
    provider === "openai"
      ? process.env.FUSE_CONTINUITY_OPENAI_MODEL
      : process.env.FUSE_CONTINUITY_ANTHROPIC_MODEL;
  if (chosen) return findModel(defaultCatalog, provider, chosen) ?? undefined;
  return tierModels(defaultPolicy, defaultCatalog, "balanced", { providers: [provider] })[0];
}

test.skipIf(!LIVE)(
  "two-provider continuity benchmark (live, Isaac's keys)",
  async () => {
    const providers = (["anthropic", "openai"] as const).filter((p) => KEYS[p]);
    expect(
      providers.length,
      "set FUSE_OPENAI_API_KEY and/or FUSE_ANTHROPIC_API_KEY",
    ).toBeGreaterThan(0);
    const rows: {
      provider: string;
      scenario: string;
      critical: string;
      pass: boolean;
      answer: string;
    }[] = [];
    for (const provider of providers) {
      const key = KEYS[provider] ?? "";
      const model = modelFor(provider);
      if (!model) throw new Error(`No ${provider} model found in data/models.json`);
      const adapter =
        provider === "openai"
          ? createOpenAIAdapter({ fetch: keyedFetch(provider, key) })
          : createAnthropicAdapter({ fetch: keyedFetch(provider, key) });
      for (const scenario of loadScenarios()) {
        const db = openTestDb();
        const t = DEFAULT_TENANT;
        const { threadId } = await buildScenario(db, t, scenario);
        const deps = { db, tenant: t, catalog: defaultCatalog, adapterFor: () => adapter };
        for (const q of scenario.questions) {
          const r = await sendMessage(deps, { threadId, text: q.ask, model });
          const answer =
            (await listMessages(db, t, threadId)).find((m) => m.id === r.assistantMessageId)
              ?.content ?? "";
          rows.push({
            provider: `${provider}/${model.id}`,
            scenario: scenario.id,
            critical: q.critical,
            pass: r.status === "complete" && answerPasses(answer, q.expect),
            answer: r.error ?? answer.replace(/\s+/g, " ").slice(0, 160),
          });
        }
      }
    }
    console.table(rows.map(({ answer: _a, ...r }) => r));
    for (const r of rows.filter((x) => !x.pass)) {
      console.log(`MISSED ${r.provider} ${r.scenario}/${r.critical}: ${r.answer}`);
    }
    for (const p of new Set(rows.map((r) => r.provider))) {
      const mine = rows.filter((r) => r.provider === p);
      const kept = mine.filter((r) => r.pass).length / mine.length;
      console.log(
        `${p}: ${String(Math.round(kept * 100))}% of critical items kept (gate ${String(GATE * 100)}%)`,
      );
      expect(kept, `${p} kept ${String(Math.round(kept * 100))}%`).toBeGreaterThanOrEqual(GATE);
    }
  },
  15 * 60 * 1000,
);
