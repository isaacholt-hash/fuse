/**
 * Token ceilings per request type (M7 step 10, LL-05), from data/context.json: never a whole
 * history, file or paste beyond what the request needs. Truncation is explicit: the request
 * says what was left out, and the context package records it.
 */
import raw from "../../data/context.json";
import type { CatalogModel } from "@/catalog/catalog";
import { textTokens } from "@/files/documents";
import type { ChatMessage } from "@/providers/types";

export interface Ceilings {
  chat: { shareOfContext: number; maxTokens: number };
  housekeepingInputTokens: number;
  localInputTokens: number;
}

export function parseCeilings(input: unknown): Ceilings {
  const o = input as {
    chat?: { share_of_context?: unknown; max_tokens?: unknown };
    housekeeping_input_tokens?: unknown;
    local_input_tokens?: unknown;
  };
  const positive = (v: unknown, where: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`context.${where}: expected a positive number`);
    }
    return v;
  };
  const share = positive(o.chat?.share_of_context, "chat.share_of_context");
  if (share > 1) throw new Error("context.chat.share_of_context: at most 1");
  return {
    chat: { shareOfContext: share, maxTokens: positive(o.chat?.max_tokens, "chat.max_tokens") },
    housekeepingInputTokens: positive(o.housekeeping_input_tokens, "housekeeping_input_tokens"),
    localInputTokens: positive(o.local_input_tokens, "local_input_tokens"),
  };
}

export const ceilings: Ceilings = parseCeilings(raw);

/** The most a chat request to `model` may carry, in rough tokens. */
export const chatCeiling = (model: Pick<CatalogModel, "contextWindow">, c = ceilings) =>
  Math.min(c.chat.maxTokens, Math.floor(model.contextWindow * c.chat.shareOfContext));

/**
 * The newest messages that fit under `budget` (after the system prompt's share), starting on a
 * user message; the latest message is always kept. Returns how many were left out.
 */
export function trimHistory(
  history: ChatMessage[],
  budget: number,
): { kept: ChatMessage[]; dropped: number; droppedTokens: number } {
  const size = (m: ChatMessage) =>
    textTokens(m.content) +
    (m.attachments ?? []).reduce(
      (sum, a) => sum + (a.kind === "text" ? textTokens(a.text) : 1_000),
      0,
    );
  let total = history.reduce((sum, m) => sum + size(m), 0);
  let start = 0;
  while (total > budget && start < history.length - 1) {
    total -= size(history[start] as ChatMessage);
    start++;
  }
  // A request starts with the user's turn.
  while (start < history.length - 1 && history[start]?.role !== "user") {
    total -= size(history[start] as ChatMessage);
    start++;
  }
  const droppedTokens = history.slice(0, start).reduce((sum, m) => sum + size(m), 0);
  return { kept: history.slice(start), dropped: start, droppedTokens };
}

/** Text cut to `tokens` rough tokens, keeping the start, with a marker saying so. */
export function clipToTokens(text: string, tokens: number): string {
  const max = tokens * 4;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[… ${String(text.length - max)} more characters left out to keep this short]`;
}
