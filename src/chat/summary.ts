// Long threads (M2 step 7, PM-06, RT-05): once a thread nears what its model takes, older turns
// are sent as a rolling summary written by the housekeeping model. Turns with attachments and the
// latest turns are always sent in full.
import type { Catalog, CatalogModel } from "@/catalog/catalog";
import { filesForMessages } from "@/storage/files";
import { listPath, type Message } from "@/storage/messages";
import { activeSummary, addSummary, listSummaries } from "@/storage/summaries";
import { housekeepingCall, type HousekeepingDeps } from "./housekeeping";

/** The latest messages that are never summarized (three exchanges). */
export const KEEP_RECENT = 6;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_OUTPUT_TOKENS = 3_000;

export const SUMMARY_SYSTEM = [
  "You keep a running summary of a long conversation between a user and an AI assistant, so the conversation can continue without the full transcript.",
  "Write a dense summary in the language of the conversation: what the user is working on, decisions made, facts, numbers, names, code and file names that matter, open questions, and the user's stated preferences.",
  "If a previous summary is given, merge it with the new messages into one summary. Drop small talk.",
  "Plain prose and short lists. No preamble: start with the summary itself.",
].join("\n");

/**
 * Input tokens a thread may reach before it's summarized for this model: three quarters of its
 * window, and just under a long-context price jump, whichever is lower.
 */
export function summaryThreshold(model: CatalogModel): number {
  const window = Math.floor(model.contextWindow * 0.75);
  const cliff = model.longContextPrice?.aboveInputTokens;
  return cliff === undefined ? window : Math.min(window, Math.floor(cliff * 0.9));
}

/** Tokens the last answer on the path took in and gave out: roughly what the next turn sends. */
export function pathTokens(path: readonly Message[]): number {
  const last = path.findLast((m) => m.role === "assistant" && m.status !== "streaming");
  if (!last) return 0;
  const u = last.usage;
  return u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens + u.outputTokens;
}

/**
 * What's sent in full once older turns are summarized up to `uptoIndex`: every turn with
 * attachments (question and its answers), then everything after the summary.
 */
export function keptMessages(
  path: readonly Message[],
  uptoIndex: number,
  withFiles: ReadonlySet<string>,
): Message[] {
  const kept: Message[] = [];
  let keeping = false;
  for (const m of path.slice(0, uptoIndex + 1)) {
    if (m.role === "user") keeping = withFiles.has(m.id);
    if (keeping) kept.push(m);
  }
  return [...kept, ...path.slice(uptoIndex + 1)];
}

/** The summarized history for a path: the summary text (if any) and the messages sent in full. */
export async function summarizedPath(
  deps: Pick<HousekeepingDeps, "db" | "tenant">,
  threadId: string,
  path: Message[],
): Promise<{ earlier: string | null; kept: Message[]; uptoId: string | null }> {
  const active = activeSummary(path, await listSummaries(deps.db, deps.tenant, threadId));
  if (!active) return { earlier: null, kept: path, uptoId: null };
  const files = await filesForMessages(
    deps.db,
    deps.tenant,
    path
      .slice(0, active.uptoIndex + 1)
      .filter((m) => m.role === "user")
      .map((m) => m.id),
  );
  return {
    earlier: active.summary.summary,
    kept: keptMessages(path, active.uptoIndex, new Set(files.keys())),
    uptoId: active.summary.uptoMessageId,
  };
}

const clip = (text: string) =>
  text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)} […]` : text;

/**
 * After an answer: if the thread has outgrown `threshold`, summarizes everything but the latest
 * turns (merged with the previous summary). Returns true when a summary was written.
 */
export async function maybeSummarize(
  deps: HousekeepingDeps,
  catalog: Catalog,
  threadId: string,
  helper: CatalogModel,
  threshold: number,
): Promise<{ summarized: boolean; error?: string }> {
  const { path } = await listPath(deps.db, deps.tenant, threadId);
  if (pathTokens(path) < threshold) return { summarized: false };
  // The summary ends on an answer, KEEP_RECENT messages before the end.
  const cut = path.length - 1 - KEEP_RECENT;
  const uptoIndex = path.slice(0, cut + 1).findLastIndex((m) => m.role === "assistant");
  const upto = path[uptoIndex];
  if (!upto) return { summarized: false };
  const previous = activeSummary(path, await listSummaries(deps.db, deps.tenant, threadId));
  if (previous && previous.uptoIndex >= uptoIndex) return { summarized: false };
  const fresh = path.slice(previous ? previous.uptoIndex + 1 : 0, uptoIndex + 1);
  const input = [
    ...(previous ? ["<previous_summary>", previous.summary.summary, "</previous_summary>"] : []),
    "<messages>",
    ...fresh
      .filter((m) => m.content.trim())
      .map((m) => `<${m.role}>\n${clip(m.content.trim())}\n</${m.role}>`),
    "</messages>",
  ].join("\n");
  const call = await housekeepingCall(deps, catalog, {
    purpose: "summary",
    threadId,
    model: helper,
    system: SUMMARY_SYSTEM,
    input,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  if (!call.ok) return { summarized: false, error: call.error };
  const text = call.text.trim();
  if (!text) return { summarized: false };
  await addSummary(deps.db, deps.tenant, threadId, upto.id, text);
  return { summarized: true };
}
