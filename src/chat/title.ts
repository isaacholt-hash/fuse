// Auto-title (M1 step 8, CH-09): after the first exchange, the housekeeping model names the chat.
// Until it answers (or if it fails) the chat keeps the first line of the question as its title.
import type { Catalog, CatalogModel } from "@/catalog/catalog";
import { listMessages, type Message } from "@/storage/messages";
import { getThread, renameThread } from "@/storage/threads";
import { housekeepingCall, type HousekeepingDeps } from "./housekeeping";

export const MAX_TITLE_CHARS = 60;
const MAX_PART_CHARS = 2_000;
// Room for reasoning models to think before a few words of title.
const MAX_OUTPUT_TOKENS = 1_000;

export const TITLE_SYSTEM = [
  "Write a short title for this conversation, as a chat app would show it in a sidebar.",
  '3 to 6 words, in the language of the user\'s message, made from the words of this conversation. Name its topic, not the request (not "User asks about…").',
  "Sentence case. No quotes, no emoji, no full stop at the end.",
  "Reply with the title only.",
].join("\n");

const clip = (text: string) =>
  text.length > MAX_PART_CHARS ? `${text.slice(0, MAX_PART_CHARS)} […]` : text;

export function titleInput(question: string, answer: string): string {
  return [
    "<user_message>",
    clip(question.trim()),
    "</user_message>",
    "<assistant_answer>",
    clip(answer.trim()),
    "</assistant_answer>",
  ].join("\n");
}

/** The model's reply made into a title, or null if there's nothing usable. */
export function cleanTitle(reply: string): string | null {
  const line =
    reply
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  const title = line
    .replace(/^(?:#+\s*|title\s*:\s*)/i, "")
    .replace(/^[*_"'“‘`]+|[*_"'”’`]+$/g, "")
    .replace(/[.。]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return null;
  return title.length > MAX_TITLE_CHARS
    ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : title;
}

/** True right after a chat's first complete answer (the newest answer), if nobody renamed it. */
export function wantsAutoTitle(titleSource: "user" | "auto", messages: Message[]): boolean {
  const answers = messages.filter((m) => m.role === "assistant");
  return (
    titleSource === "auto" &&
    answers.at(-1)?.status === "complete" &&
    answers.filter((m) => m.status === "complete").length === 1
  );
}

/** Names the thread from its first exchange. Returns the new title, or null if unchanged. */
export async function autoTitle(
  deps: HousekeepingDeps,
  catalog: Catalog,
  threadId: string,
  model: CatalogModel,
): Promise<{ title: string | null; error?: string }> {
  const { db, tenant } = deps;
  const thread = await getThread(db, tenant, threadId);
  if (!thread || thread.titleSource !== "auto") return { title: null };
  const messages = await listMessages(db, tenant, threadId);
  const question = messages.find((m) => m.role === "user");
  const answer = messages.find((m) => m.role === "assistant" && m.status === "complete");
  if (!question || !answer || (!question.content.trim() && !answer.content.trim())) {
    return { title: null };
  }
  const call = await housekeepingCall(deps, catalog, {
    purpose: "title",
    threadId,
    model,
    system: TITLE_SYSTEM,
    input: titleInput(question.content, answer.content),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  if (!call.ok) return { title: null, error: call.error };
  const title = cleanTitle(call.text);
  // Renamed by hand while the model was thinking: keep the user's name.
  const now = await getThread(db, tenant, threadId);
  if (!title || now?.titleSource !== "auto") return { title: null };
  await renameThread(db, tenant, threadId, title, "auto");
  return { title };
}
