// @vitest-environment node
// M7 step 9 (LL-09): the local model on this computer, measured. `pnpm local:bench` runs FUSE's
// real worker on the installed model (or FUSE_LOCAL_MODEL) over the shipped routing test set and
// a few chats to title, with no key and no network. It reports the classifier's second opinion
// (parse rate, tier accuracy, false downgrades), title quality, p50/p95 latency and peak memory.
// Skipped in `pnpm test`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanTitle, TITLE_SYSTEM, titleInput } from "@/chat/title";
import { classify } from "@/routing/classify";
import { CLASSIFY_SYSTEM, parseClassifyReply } from "@/routing/classifyFallback";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { parseGoldenSet } from "@/routing/golden";
import { chooseTier, TIER_ORDER } from "@/routing/policy";
import { findBinary, findModel, modelsDir, NodeWorker } from "./testing/nodeWorker";

const LIVE = import.meta.env.MODE === "localbench";
const ROOT = join(import.meta.dirname, "..", "..");

const CHATS: [string, string][] = [
  [
    "How do I convert a pandas column from string to datetime, skipping bad values?",
    "Use pd.to_datetime(df['col'], errors='coerce'); bad values become NaT.",
  ],
  [
    "We're going to Lisbon with two kids in May. What should we see?",
    "Belém, the Oceanário, tram 28 and a day trip to Sintra.",
  ],
  [
    "Can you help me write a toast for my sister's wedding?",
    "Of course: start with a short story about the two of you…",
  ],
  [
    "Why does my sourdough come out flat?",
    "Usually an under-active starter or over-proofing; try a shorter bulk rise.",
  ],
  [
    "Explain the difference between TCP and UDP.",
    "TCP is connection-based and reliable; UDP is connectionless and faster.",
  ],
];

const pct = (n: number, d: number) => (d === 0 ? "—" : `${String(Math.round((n / d) * 100))}%`);
function quantile(ms: number[], q: number): number {
  const s = [...ms].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

test.skipIf(!LIVE)(
  "local model benchmark (this computer, no keys)",
  async () => {
    const binary = findBinary();
    if (!binary) {
      throw new Error(
        "Build FUSE first: cargo build --release --manifest-path src-tauri/Cargo.toml (or set FUSE_BIN).",
      );
    }
    const model = findModel();
    if (!model) {
      throw new Error(
        `No local model found in ${modelsDir()}. That's where FUSE on this computer installs it (Settings → Local model); a model installed on another computer isn't here. Or set FUSE_LOCAL_MODEL to a .gguf file.`,
      );
    }
    const set = parseGoldenSet(
      readFileSync(join(ROOT, "data", "routing-test", "prompts.jsonl"), "utf8"),
    );
    if (!set.ok) throw new Error(set.errors.join("\n"));
    const prompts = set.prompts.filter((p) => !p.needsContext);
    const worker = new NodeWorker(binary);
    try {
      const loadMs = await worker.load(model.path, 4);
      const rank = (t: string) => TIER_ORDER.indexOf(t as (typeof TIER_ORDER)[number]);
      let parsed = 0;
      let right = 0;
      let heuristicRight = 0;
      let downgrades = 0;
      const classifyMs: number[] = [];
      for (const p of prompts) {
        const heuristic = classify({ text: p.prompt });
        if (chooseTier(defaultPolicy, heuristic).tier === p.expectedTier) heuristicRight++;
        const out = await worker.generate(CLASSIFY_SYSTEM, p.prompt, 60);
        classifyMs.push(out.ms);
        const read = parseClassifyReply(out.text);
        const task = read ? { ...heuristic, ...read, unsure: false } : heuristic;
        if (read) parsed++;
        const tier = chooseTier(defaultPolicy, task).tier;
        if (tier === p.expectedTier) right++;
        else if (rank(tier) < rank(p.expectedTier)) downgrades++;
      }
      let titled = 0;
      const titleMs: number[] = [];
      const titles: string[] = [];
      for (const [q, a] of CHATS) {
        const out = await worker.generate(TITLE_SYSTEM, titleInput(q, a), 40);
        titleMs.push(out.ms);
        const title = cleanTitle(out.text);
        titles.push(title ?? `(unusable: ${out.text.slice(0, 40)})`);
        // Usable: short, and about this chat (it shares a word of 4+ letters with the question),
        // so a title copied from the prompt or another chat doesn't count.
        const words = new Set(q.toLowerCase().match(/[a-z]{4,}/g) ?? []);
        const onTopic = (title?.toLowerCase().match(/[a-z]{4,}/g) ?? []).some((w) =>
          [...words].some((q) => q.startsWith(w.slice(0, 5)) || w.startsWith(q.slice(0, 5))),
        );
        if (title && title.split(/\s+/).length <= 8 && onTopic) titled++;
      }
      const peak = worker.peakMemory();
      console.table([
        { measure: "model", value: model.profile?.displayName ?? model.path },
        { measure: "load time", value: secs(loadMs) },
        { measure: "classify: replies parsed", value: pct(parsed, prompts.length) },
        {
          measure: "classify: tier right (heuristics alone)",
          value: pct(heuristicRight, prompts.length),
        },
        { measure: "classify: tier right (with local check)", value: pct(right, prompts.length) },
        { measure: "classify: false downgrades", value: pct(downgrades, prompts.length) },
        {
          measure: "classify: p50 / p95",
          value: `${secs(quantile(classifyMs, 0.5))} / ${secs(quantile(classifyMs, 0.95))}`,
        },
        { measure: "titles usable", value: `${String(titled)} of ${String(CHATS.length)}` },
        {
          measure: "title: p50 / p95",
          value: `${secs(quantile(titleMs, 0.5))} / ${secs(quantile(titleMs, 0.95))}`,
        },
        {
          measure: "peak memory",
          value: peak === null ? "n/a (Linux only)" : `${(peak / 1e9).toFixed(2)} GB`,
        },
      ]);
      console.log(`titles: ${titles.join(" | ")}`);
      console.log(
        `local: ${pct(right, prompts.length)} tier right, ${pct(downgrades, prompts.length)} false downgrades, titles ${String(titled)}/${String(CHATS.length)}`,
      );
      expect(parsed).toBeGreaterThan(0);
    } finally {
      worker.stop();
    }
  },
  30 * 60_000,
);
