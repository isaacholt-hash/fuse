// What the classifier sees for one question, built from the chat on screen and its attachments.
import type { ClassifyInput } from "@/routing/classify";
import type { FileRecord } from "@/storage/files";
import type { Message } from "@/storage/messages";

/** A rough size for an image before the provider is known (about 1,000×1,000 px). */
const IMAGE_TOKENS = 1_600;

/** Input tokens so far: the last answer's input and output are the history the next send carries. */
function historyTokens(messages: readonly Message[]): number {
  const last = messages.findLast((m) => m.role === "assistant" && m.status !== "streaming");
  if (!last) return 0;
  const u = last.usage;
  return u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens + u.outputTokens;
}

export function classifyInput(
  text: string,
  files: readonly FileRecord[],
  history: readonly Message[],
  webSearch: boolean,
): ClassifyInput {
  const images = files.filter((f) => f.mime.startsWith("image/"));
  const documents = files.filter((f) => !f.mime.startsWith("image/"));
  return {
    text,
    images: images.length,
    documents: documents.length,
    contextTokens:
      historyTokens(history) +
      Math.ceil(text.length / 4) +
      images.length * IMAGE_TOKENS +
      documents.reduce((sum, f) => sum + (f.tokenEstimate ?? 0), 0),
    webSearch,
  };
}
