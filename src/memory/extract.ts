// Memory extraction v1 (PM-03): after a chat, a cheap model suggests facts to remember, updates and
// deletions. Nothing is saved until you approve it. Secrets are filtered out before storing (PM-05).
import { inScope } from "./inject";
import type { Catalog, CatalogModel } from "@/catalog/catalog";
import { housekeepingCall, type HousekeepingDeps } from "@/chat/housekeeping";
import {
  addProposals,
  listMemories,
  SUGGESTED_KINDS,
  proposalTexts,
  type Memory,
  type MemoryKind,
  type NewProposal,
} from "@/storage/memories";
import { listMessages, type Message } from "@/storage/messages";
import { getProject } from "@/storage/projects";
import { getThread, markMemoryChecked } from "@/storage/threads";
import { findSecret, type SecretKind } from "./secrets";

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
    'Kinds: fact (about the user or what they\'re working on), preference (how they like things done), person (someone in their life or work), constraint (a rule or limit their work must keep to, e.g. "The trip budget is £2,000."), task (something they still have to do, e.g. "Order the oak samples.").',
    ...(projectName
      ? [
          `This chat is in the user's project "${projectName}". Add "project_only": true to facts that only matter inside that project.`,
        ]
      : []),
    "",
    "Reply with JSON only, no other text, in this shape:",
    '{"suggestions": [{"op": "add", "text": "...", "kind": "fact", "confidence": 90}, {"op": "update", "id": "M2", "text": "...", "kind": "preference", "confidence": 80}, {"op": "delete", "id": "M3"}]}',
    "confidence is 0-100: how sure you are the user would want this remembered.",
  ].join("\n");
}

export function extractionInput(
  conversation: string,
  saved: { ref: string; memory: Memory }[],
  previous: string[],
): string {
  const facts = saved.map((s) => `${s.ref} [${s.memory.kind}] ${s.memory.text}`);
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
  kind: MemoryKind;
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
    // Never a decision: those are only ever added by you (PM-15).
    const kind = SUGGESTED_KINDS.includes(o.kind as MemoryKind) ? (o.kind as MemoryKind) : "fact";
    const confidence =
      typeof o.confidence === "number" && Number.isFinite(o.confidence)
        ? Math.round(Math.min(100, Math.max(0, o.confidence)))
        : 70;
    out.push({
      op,
      ref: op === "add" ? null : ref,
      text,
      kind,
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

export type ExtractDeps = HousekeepingDeps;

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
  // Decisions are yours alone (PM-15): the model never sees them to change.
  const saved = (await listMemories(db, tenant))
    .filter((m) => m.kind !== "decision" && inScope(m, { projectId: thread.projectId, threadId }))
    .map((memory, i) => ({ ref: `M${String(i + 1)}`, memory }));
  const previous = await proposalTexts(db, tenant);
  const system = extractionSystem(project?.name ?? null);
  const input = extractionInput(transcript(messages), saved, previous.slice(-MAX_PREVIOUS));

  const call = await housekeepingCall(deps, catalog, {
    purpose: "memory",
    threadId,
    model,
    system,
    input,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(signal ? { signal } : {}),
  });
  if (!call.ok) return { proposed: 0, skipped: [], costMicroUsd: 0, error: call.error };
  const reply = call.text;

  const byRef = new Map(saved.map((s) => [s.ref, s.memory]));
  const seen = new Set([...saved.map((s) => sameText(s.memory.text)), ...previous.map(sameText)]);
  const skipped: SecretKind[] = [];
  const proposals: NewProposal[] = [];
  for (const s of parseSuggestions(reply)) {
    const target = s.ref ? byRef.get(s.ref) : undefined;
    if (s.op !== "add" && !target) continue;
    // Authority order (PM-15): a suggestion never changes or removes what you entered or
    // imported. A change becomes a new fact, which the review shows against yours (PM-11).
    const guarded = target !== undefined && target.authority !== "extracted";
    if (guarded && s.op === "delete") continue;
    const op = guarded ? "add" : s.op;
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
      op,
      memoryId: op === "add" ? null : (target?.id ?? null),
      text: op === "delete" ? "" : s.text,
      kind: op === "delete" && target ? target.kind : s.kind,
      // A guarded change keeps the original's project; a new fact is the project's when asked.
      projectId:
        op !== "add"
          ? null
          : guarded
            ? target.projectId
            : s.projectOnly || s.kind === "task"
              ? thread.projectId
              : null,
      confidence: s.confidence,
      sourceThreadId: threadId,
      extractionModel: model.id,
    });
  }
  await addProposals(db, tenant, proposals);
  await markMemoryChecked(db, tenant, threadId, checkedUpTo);
  return { proposed: proposals.length, skipped, costMicroUsd: call.costMicroUsd };
}

/** True when a thread has messages its last memory check didn't cover. */
export const needsMemoryCheck = (t: {
  lastMessageAt: number | null;
  memoryCheckedAt: number | null;
}) =>
  t.lastMessageAt !== null && (t.memoryCheckedAt === null || t.lastMessageAt > t.memoryCheckedAt);
