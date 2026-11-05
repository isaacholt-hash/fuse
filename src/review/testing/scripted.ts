/** FUSE_REVIEW_FIXTURE: synthetic model responses, reachable only from isolated test entries. */
import type { ProviderAdapter, StreamEvent } from "@/providers/types";
import type { ProviderId } from "@/catalog/catalog";
import type { ReviewSnapshot } from "../types";
import { lines } from "../validate";
export function recordedReviewAdapter(
  provider: ProviderId,
  fallback?: ProviderAdapter,
): ProviderAdapter {
  return {
    provider,
    listModels: () => Promise.resolve([]),
    async *streamChat(history, model, options, signal): AsyncGenerator<StreamEvent> {
      if (!options.system?.includes("<code_review>")) {
        if (!fallback) throw new Error("The isolated review runner only accepts review requests.");
        yield* fallback.streamChat(history, model, options, signal);
        return;
      }
      const input = JSON.parse(String(history[0]?.content)) as {
        snapshot: ReviewSnapshot;
        instruction: string;
      };
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("Recorded review stopped."));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, 600);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      const file = input.snapshot.files[0],
        newSide = Boolean(file?.changedNew.length),
        side = newSide ? "new" : "old";
      const line = (newSide ? file?.changedNew : file?.changedOld)?.[0] ?? 1;
      const quote = lines((newSide ? file?.newText : file?.oldText) ?? "")[line - 1] ?? "";
      const final = input.instruction.includes("Return only one JSON object");
      const text = final
        ? JSON.stringify({
            snapshotId: input.snapshot.id,
            findings:
              file && quote
                ? [
                    {
                      severity: "P1",
                      title: "Preserve the original divisor",
                      consequence:
                        "When den is one, subtracting one makes the divisor zero and returns Infinity instead of a finite ratio.",
                      path: file.path,
                      side,
                      revision: newSide ? file.newRevision : file.oldRevision,
                      startLine: line,
                      endLine: line,
                      quote,
                    },
                  ]
                : [],
            limitations: ["Synthetic review fixture; no live provider request or test execution."],
          })
        : "Inspect the changed divisor and the den=1 boundary using the pinned source.";
      yield { type: "text", text };
      yield {
        type: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: "end_turn",
        providerRequestId: null,
        attempts: 1,
        turn: { provider, model, items: [] },
      };
    },
  };
}
