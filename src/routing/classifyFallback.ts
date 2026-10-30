/**
 * RT-02's fallback: when the local heuristics are unsure, the Cheap tier reads the question and
 * says what kind it is and how hard. One short call (`purpose: classify`, logged with its cost);
 * any failure or odd reply keeps the local answer.
 */
import type { Catalog, CatalogModel } from "@/catalog/catalog";
import { cacheGet, cacheKey, cachePut } from "@/cache/responseCache";
import { housekeepingCall, type HousekeepingDeps } from "@/chat/housekeeping";
import { getThread } from "@/storage/threads";
import type { Classification } from "./classify";
import type { Complexity, Intent } from "./policy";

const INTENTS: readonly Intent[] = [
  "chat",
  "writing",
  "coding",
  "analysis",
  "long_document",
  "reasoning",
  "vision",
  "creative",
];
const COMPLEXITIES: readonly Complexity[] = ["low", "medium", "high"];
/** The question as sent for classifying: enough to judge, never a whole paste. */
const MAX_INPUT_CHARS = 4000;

export const CLASSIFY_SYSTEM = [
  "You sort requests to an AI assistant before they're answered. Reply with JSON only, no prose:",
  '{"intent": "<one of chat, writing, coding, analysis, long_document, reasoning, creative>", "complexity": "<low, medium or high>"}',
  "complexity is high only for demanding work: multi-step reasoning, architecture or design, careful analysis, long or exacting output. Everyday questions are low or medium.",
].join("\n");

/** The model's reply as intent and complexity, or null if it isn't one. */
export function parseClassifyReply(
  text: string,
): { intent: Intent; complexity: Complexity } | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as { intent?: unknown; complexity?: unknown };
    const intent = INTENTS.find((i) => i === raw.intent);
    const complexity = COMPLEXITIES.find((c) => c === raw.complexity);
    return intent && complexity ? { intent, complexity } : null;
  } catch {
    return null;
  }
}

/** The local classification, corrected by the Cheap tier when the heuristics were unsure. */
export async function checkClassification(
  deps: HousekeepingDeps,
  catalog: Catalog,
  model: CatalogModel,
  local: Classification,
  question: string,
  threadId: string | null,
): Promise<Classification> {
  if (!local.unsure) return local;
  const input = question.slice(0, MAX_INPUT_CHARS);
  // LL-06: the same words get the same second opinion for a month, in the same project only.
  const thread = threadId ? await getThread(deps.db, deps.tenant, threadId) : null;
  const scope = thread?.projectId ?? "none";
  const key =
    thread?.incognito === true
      ? null
      : await cacheKey([
          "classify",
          `${model.provider}/${model.id}`,
          CLASSIFY_SYSTEM,
          input,
          scope,
        ]);
  const cached = key ? await cacheGet(deps.db, deps.tenant, key, scope) : null;
  let read = cached ? parseClassifyReply(cached.response) : null;
  if (!read) {
    const call = await housekeepingCall(deps, catalog, {
      purpose: "classify",
      threadId,
      model,
      system: CLASSIFY_SYSTEM,
      input,
      maxOutputTokens: 60,
    });
    read = call.ok ? parseClassifyReply(call.text) : null;
    let answered = call;
    if (!read && call.ok && call.provider === "local" && model.provider !== "local") {
      // LL-04: an unreadable local reply counts as a failure: the cloud model, once.
      answered = await housekeepingCall({ ...deps, local: null }, catalog, {
        purpose: "classify",
        threadId,
        model,
        system: CLASSIFY_SYSTEM,
        input,
        maxOutputTokens: 60,
      });
      read = answered.ok ? parseClassifyReply(answered.text) : null;
    }
    if (read && key && answered.ok) {
      await cachePut(deps.db, deps.tenant, {
        key,
        kind: "classify",
        scope,
        model: `${model.provider}/${model.id}`,
        response: JSON.stringify(read),
        costMicroUsd: answered.costMicroUsd,
      });
    }
  }
  if (!read) return local;
  return {
    ...local,
    intent: read.intent,
    complexity: read.complexity,
    unsure: false,
    signals: [...local.signals, `checked by ${model.displayName}`],
  };
}
