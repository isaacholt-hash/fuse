/** FUSE_PARALLEL_FIXTURE: synthetic model replies; native worktrees/files/owner are real. */
import type { ProviderId } from "@/catalog/catalog";
import type { ProviderAdapter, StreamEvent } from "@/providers/types";

export function recordedParallelAdapter(
  provider: ProviderId,
  fallback?: ProviderAdapter,
): ProviderAdapter {
  return {
    provider,
    listModels: () => Promise.resolve([]),
    async *streamChat(history, model, options, signal): AsyncGenerator<StreamEvent> {
      let synthesis: string | null = null;
      let evidence = "";
      try {
        const value: unknown = JSON.parse(history[0]?.content ?? "");
        if (
          value &&
          typeof value === "object" &&
          "task" in value &&
          typeof value.task === "string" &&
          "evidence" in value
        ) {
          synthesis = value.task;
          evidence = JSON.stringify(value.evidence);
        }
      } catch {
        /* Ordinary tool turns are plain text. */
      }
      const task = synthesis ?? history.find((m) => m.role === "user")?.content ?? "";
      const child = task.includes("Child task approved through the parent run.");
      const plan = options.system?.includes("<coding_plan>") ?? false;
      const known = child || task.includes("Recorded parallel tasks");
      if (!known || (!plan && !synthesis && !options.tools?.length)) {
        if (!fallback)
          throw new Error("The isolated parallel fixture received an unexpected model request.");
        yield* fallback.streamChat(history, model, options, signal);
        return;
      }
      const finished = synthesis !== null || history.some((m) => m.toolResults?.length);
      const records =
        evidence + history.flatMap((m) => m.toolResults?.map((r) => r.content) ?? []).join("\n");
      const declined = records.includes(child ? "declined" : "declined child execution");
      // Leave enough time for the caller to navigate away after approving; the owner continues.
      if (child && !synthesis) await new Promise((r) => setTimeout(r, 2000));
      const text = plan
        ? child
          ? "1. Inspect the approved child task and committed base. 2. Write only its requested result. 3. Check that the changes stay in this worktree."
          : "1. Propose two isolated child tasks. 2. Preserve the parent. 3. Report their separate results without integration."
        : child && declined
          ? "Child edit was declined; no file changed."
          : child
            ? "Child edit retained in its own worktree."
            : declined
              ? "Parallel work was declined; no child was started."
              : finished
                ? "Parallel children finished independently. Their edits remain separate; nothing was integrated or pushed."
                : "The two child tasks require your approval.";
      yield { type: "text", text };
      if (!plan && !finished)
        yield {
          type: "tool_call",
          call: child
            ? {
                id: "recorded-child-write",
                name: "write_file",
                input: {
                  path: "result.txt",
                  content: task.includes("alpha") ? "alpha\n" : "beta\n",
                },
              }
            : {
                id: "recorded-delegation",
                name: "delegate_code",
                input: { tasks: ["Write alpha in result.txt.", "Write beta in result.txt."] },
              },
        };
      yield {
        type: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: !plan && !finished ? "tool_use" : "end_turn",
        providerRequestId: null,
        attempts: 1,
        turn: { provider, model, items: [] },
      };
    },
  };
}
