// Memory extraction v1 (PM-03): after a chat, a cheap model suggests facts to remember, updates and
// deletions. Nothing is saved until you approve it. Secrets are filtered out before storing (PM-05).
import { priceFor, type Catalog, type CatalogModel, type ProviderId } from "@/catalog/catalog";
import { cost } from "@/cost/cost";
import { PROVIDER_NAMES } from "@/chat/sendMessage";
import { ProviderError, userMessage } from "@/providers/errors";
import type { ProviderAdapter, StreamDone } from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import {
  addProposals,
  listMemories,
  MEMORY_CATEGORIES,
  proposalTexts,
  type Memory,
  type MemoryCategory,
  type NewProposal,
} from "@/storage/memories";
import { listMessages, type Message } from "@/storage/messages";
import { getProject } from "@/storage/projects";
import { logRequest } from "@/storage/requestLog";
import type { SqlDb } from "@/storage/sql";
import { getThread, markMemoryChecked } from "@/storage/threads";
import { EMPTY_USAGE, type Usage } from "@/storage/usage";
import { findSecret, type SecretKind } from "./secrets";

/**
 * The model that does housekeeping (memory now, titles in step 8): the cheapest model, by input +
 * output price in data/models.json, from a provider with a saved key, the chat's provider first on
 * a tie. A stand-in until the Cheap tier exists (step 9, data/routing.json).
 */
export function housekeepingModel(
  catalog: Catalog,
  providers: readonly ProviderId[],
  prefer?: ProviderId,
): CatalogModel | null {
  const usable = catalog.models.filter((m) => providers.includes(m.provider));
  usable.sort(
    (a, b) =>
      a.price.input + a.price.output - (b.price.input + b.price.output) ||
      Number(b.provider === prefer) - Number(a.provider === prefer),
  );
  return usable[0] ?? null;
}

/** The transcript sent for extraction is capped, newest turns kept. */
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_TURN_CHARS = 4_000;
const MAX_OUTPUT_TOKENS = 4_000;
/** Earlier suggestions shown to the model so it doesn't repeat them. */
const MAX_PREVIOUS = 50;

export function transcript(messages: Message[]): string {
  const turns = messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        m.status !== "error" &&
        m.content.trim() !== "",
    )
    .map((m) => {
      const text = m.content.trim();
      const clipped = text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)} […]` : text;
      return `${m.role === "user" ? "User" : "Assistant"}: ${clipped}`;
    });
  const kept: string[] = [];
  let size = 0;
  for (const turn of turns.reverse()) {
    if (size + turn.length > MAX_TRANSCRIPT_CHARS && kept.length > 0) break;
    kept.unshift(turn);
    size += turn.length + 2;
  }
  return kept.join("\n\n");
}

export function extractionSystem(projectName: string | null): string {
  return [
    "You keep a short list of lasting facts about the user, so future chats with any AI model can help them better. Read the conversation and suggest changes to the list.",
    "",
    "Suggest a fact only if it is:",
    "- about the user: their life, work, preferences, the people they mention, what they're working on (not general knowledge about the topic);",
    "- likely to stay true and be useful in later, unrelated chats;",
    "- said or clearly implied by the user, not guessed.",
    "Never suggest passwords, API keys, card or account numbers, or ID numbers.",
    'Write each fact as one short sentence about the user, e.g. "Prefers metric units." or "Has a daughter, Maya, aged 7."',
    "If the conversation changes or contradicts a saved fact, suggest an update with its id. If it shows a saved fact is no longer true, suggest deleting it. Don't repeat saved or already-suggested facts.",
    "Most conversations have nothing worth remembering. An empty list is the usual answer.",
    "",
    "Categories: fact (about the user themselves), preference (how they like things done), person (someone in their life or work), project (something they're working on).",
    ...(projectName
      ? [
          `This chat is in the user's project "${projectName}". Add "project_only": true to facts that only matter inside that project.`,
        ]
      : []),
    "",
    "Reply with JSON only, no other text, in this shape:",
    '{"suggestions": [{"op": "add", "text": "...", "category": "fact", "confidence": 90}, {"op": "update", "id": "M2", "text": "...", "category": "preference", "confidence": 80}, {"op": "delete", "id": "M3"}]}',
    "confidence is 0-100: how sure you are the user would want this remembered.",
  ].join("\n");
}

export function extractionInput(
  conversation: string,
  saved: { ref: string; memory: Memory }[],
  previous: string[],
): string {
  const facts = saved.map((s) => `${s.ref} [${s.memory.category}] ${s.memory.text}`);
  return [
    "<saved_facts>",
    ...(facts.length ? facts : ["(none yet)"]),
    "</saved_facts>",
    ...(previous.length
      ? ["<already_suggested>", ...previous.map((p) => `- ${p}`), "</already_suggested>"]
      : []),
    "<conversation>",
    conversation,
    "</conversation>",
  ].join("\n");
}

export interface RawSuggestion {
  op: "add" | "update" | "delete";
  /** The saved fact's short reference (M1, M2…) for update and delete. */
  ref: string | null;
  text: string;
  category: MemoryCategory;
  confidence: number;
  projectOnly: boolean;
}

/** Reads the model's JSON; anything malformed is dropped rather than guessed at. */
export function parseSuggestions(reply: string): RawSuggestion[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(list)) return [];
  const out: RawSuggestion[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const op = o.op;
    if (op !== "add" && op !== "update" && op !== "delete") continue;
    const ref = typeof o.id === "string" ? o.id.trim().toUpperCase() : null;
    if (op !== "add" && !ref) continue;
    const text = typeof o.text === "string" ? o.text.trim().replace(/\s+/g, " ") : "";
    if (op !== "delete" && !text) continue;
    const category = MEMORY_CATEGORIES.includes(o.category as MemoryCategory)
      ? (o.category as MemoryCategory)
      : "fact";
    const confidence =
      typeof o.confidence === "number" && Number.isFinite(o.confidence)
        ? Math.round(Math.min(100, Math.max(0, o.confidence)))
        : 70;
    out.push({
      op,
      ref: op === "add" ? null : ref,
      text,
      category,
      confidence,
      projectOnly: o.project_only === true,
    });
  }
  return out;
}

/** Compares facts ignoring case, spacing and punctuation. */
const sameText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export interface ExtractDeps {
  db: SqlDb;
  tenant: Tenant;
  adapterFor: (provider: ProviderId) => ProviderAdapter;
  now?: () => number;
}

export interface ExtractResult {
  /** Suggestions saved for review. */
  proposed: number;
  /** Suggestions dropped because they held a secret (shown, never stored). */
  skipped: SecretKind[];
  costMicroUsd: number;
  error?: string;
}

/** Asks `model` for memory suggestions from one thread and saves them as pending proposals. */
export async function suggestMemories(
  deps: ExtractDeps,
  catalog: Catalog,
  threadId: string,
  model: CatalogModel,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const { db, tenant } = deps;
  const now = deps.now ?? Date.now;
  const thread = await getThread(db, tenant, threadId);
  if (!thread) return { proposed: 0, skipped: [], costMicroUsd: 0 };
  const messages = await listMessages(db, tenant, threadId);
  const checkedUpTo = thread.lastMessageAt ?? now();
  if (!messages.some((m) => m.role === "assistant" && m.status === "complete")) {
    await markMemoryChecked(db, tenant, threadId, checkedUpTo);
    return { proposed: 0, skipped: [], costMicroUsd: 0 };
  }

  const project = thread.projectId ? await getProject(db, tenant, thread.projectId) : null;
  const saved = (await listMemories(db, tenant))
    .filter((m) => m.projectId === null || m.projectId === thread.projectId)
    .map((memory, i) => ({ ref: `M${String(i + 1)}`, memory }));
  const previous = await proposalTexts(db, tenant);
  const system = extractionSystem(project?.name ?? null);
  const input = extractionInput(transcript(messages), saved, previous.slice(-MAX_PREVIOUS));

  const started = now();
  let reply = "";
  let done: StreamDone | null = null;
  let failure: ProviderError | null = null;
  try {
    const stream = deps
      .adapterFor(model.provider)
      .streamChat(
        [{ role: "user", content: input }],
        model.id,
        { system, maxOutputTokens: MAX_OUTPUT_TOKENS },
        signal,
      );
    for await (const ev of stream) {
      if (ev.type === "text") reply += ev.text;
      else if (ev.type === "done") done = ev;
    }
  } catch (e) {
    failure =
      e instanceof ProviderError
        ? e
        : new ProviderError("stream", e instanceof Error ? e.message : String(e));
  }

  let usage: Usage = { ...EMPTY_USAGE, latencyMs: now() - started };
  if (done) {
    const t = done.usage;
    const totalInput = t.inputTokens + t.cachedInputTokens + t.cacheWriteTokens;
    usage = {
      ...usage,
      ...t,
      costMicroUsd: done.usageReported ? cost({ ...usage, ...t }, priceFor(model, totalInput)) : 0,
      priceVersion: done.usageReported ? catalog.priceVersion : null,
    };
  }
  await logRequest(db, tenant, {
    threadId,
    messageId: null,
    purpose: "memory",
    provider: model.provider,
    model: model.id,
    attempt: done?.attempts ?? 1,
    usage,
    httpStatus: failure?.status ?? (done ? 200 : null),
    errorCode: failure ? (failure.code ?? failure.kind) : null,
    errorMessage: failure ? failure.message.slice(0, 500) : null,
    providerRequestId: done?.providerRequestId ?? failure?.providerRequestId ?? null,
  });
  if (!done) {
    return {
      proposed: 0,
      skipped: [],
      costMicroUsd: 0,
      error: failure
        ? userMessage(failure, PROVIDER_NAMES[model.provider])
        : "No reply from the model",
    };
  }

  const byRef = new Map(saved.map((s) => [s.ref, s.memory]));
  const seen = new Set([...saved.map((s) => sameText(s.memory.text)), ...previous.map(sameText)]);
  const skipped: SecretKind[] = [];
  const proposals: NewProposal[] = [];
  for (const s of parseSuggestions(reply)) {
    const target = s.ref ? byRef.get(s.ref) : undefined;
    if (s.op !== "add" && !target) continue;
    if (s.op !== "delete") {
      const secret = findSecret(s.text);
      if (secret) {
        skipped.push(secret);
        continue;
      }
      const key = sameText(s.text);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    proposals.push({
      op: s.op,
      memoryId: target?.id ?? null,
      text: s.op === "delete" ? "" : s.text,
      category: s.op === "delete" && target ? target.category : s.category,
      projectId: s.op === "add" && s.projectOnly && thread.projectId ? thread.projectId : null,
      confidence: s.confidence,
      sourceThreadId: threadId,
    });
  }
  await addProposals(db, tenant, proposals);
  await markMemoryChecked(db, tenant, threadId, checkedUpTo);
  return { proposed: proposals.length, skipped, costMicroUsd: usage.costMicroUsd };
}

/** True when a thread has messages its last memory check didn't cover. */
export const needsMemoryCheck = (t: {
  lastMessageAt: number | null;
  memoryCheckedAt: number | null;
}) =>
  t.lastMessageAt !== null && (t.memoryCheckedAt === null || t.lastMessageAt > t.memoryCheckedAt);
