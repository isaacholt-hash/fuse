// @vitest-environment node
// M8 step 16: one short chat on each provider with Isaac's own keys (never in CI):
//   FUSE_ANTHROPIC_API_KEY=… FUSE_OPENAI_API_KEY=… pnpm chat:live
// Either key alone runs that provider; FUSE_CHAT_ANTHROPIC_MODEL / FUSE_CHAT_OPENAI_MODEL pick
// the model (default: the cheapest Balanced one). It prints only pass or fail, tokens and cost.
import { cost, formatUsd } from "@/cost/cost";
import { EMPTY_USAGE } from "@/storage/usage";
import { keyedProviders, liveAdapter, liveModel } from "@/agent/testing/live";

const LIVE = import.meta.env.MODE === "chat";

test.skipIf(!LIVE)(
  "a short chat on each provider (live, Isaac's keys)",
  async () => {
    const providers = keyedProviders();
    expect(
      providers.length,
      "set FUSE_OPENAI_API_KEY and/or FUSE_ANTHROPIC_API_KEY",
    ).toBeGreaterThan(0);
    const rows: { provider: string; pass: boolean; in: number; out: number; cost: string }[] = [];
    for (const provider of providers) {
      const model = liveModel(
        provider,
        provider === "openai"
          ? process.env.FUSE_CHAT_OPENAI_MODEL
          : process.env.FUSE_CHAT_ANTHROPIC_MODEL,
      );
      if (!model) throw new Error(`No ${provider} model found in data/models.json`);
      let text = "";
      let usage = EMPTY_USAGE;
      for await (const e of liveAdapter(provider).streamChat(
        [{ role: "user", content: "Reply with the single word: ready" }],
        model.id,
        { maxOutputTokens: 200 },
      )) {
        if (e.type === "text") text += e.text;
        if (e.type === "done") usage = { ...EMPTY_USAGE, ...e.usage };
      }
      rows.push({
        provider: `${provider}/${model.id}`,
        pass: /ready/i.test(text),
        in: usage.inputTokens + usage.cachedInputTokens,
        out: usage.outputTokens,
        cost: formatUsd(cost(usage, model.price)),
      });
    }
    console.table(rows);
    for (const r of rows) expect(r.pass, `${r.provider} didn't answer`).toBe(true);
  },
  2 * 60 * 1000,
);
