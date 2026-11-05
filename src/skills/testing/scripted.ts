/** FUSE_SKILL_SCRIPT_FIXTURE: synthetic model only; never imported by a release entry. */
import type { ProviderId } from "@/catalog/catalog";
import type { ProviderAdapter, StreamEvent } from "@/providers/types";
import { skillCommands } from "../invoke";
export function recordedSkillAdapter(
  provider: ProviderId,
  fallback?: ProviderAdapter,
): ProviderAdapter {
  return {
    provider,
    listModels: () => Promise.resolve([]),
    async *streamChat(history, model, options, signal): AsyncGenerator<StreamEvent> {
      await Promise.resolve();
      let synthesis: { task: string; evidence: unknown } | null = null;
      try {
        const value: unknown = JSON.parse(history[0]?.content ?? "");
        if (
          value &&
          typeof value === "object" &&
          "task" in value &&
          typeof value.task === "string" &&
          "evidence" in value
        )
          synthesis = { task: value.task, evidence: value.evidence };
      } catch {
        /* Ordinary work turns use plain text. */
      }
      const task =
        synthesis?.task ??
        history
          .filter((m) => m.role === "user")
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .find((t) => t.startsWith("/skill ")) ??
        "";
      const versionId = skillCommands(task)[0]?.versionId;
      const declined =
        Boolean(synthesis && JSON.stringify(synthesis.evidence).includes("declined")) ||
        history.some((m) => m.toolResults?.some((r) => r.content.includes("declined")));
      const finished = synthesis !== null || history.some((m) => m.toolResults?.length);
      const hasScript = synthesis
        ? JSON.stringify(synthesis.evidence).includes('"tool":"run_skill_script"')
        : history.some((m) => m.toolResults?.length);
      if (!versionId) {
        if (!fallback) throw new Error("Isolated skill fixture requires an explicit pin.");
        yield* fallback.streamChat(history, model, options, signal);
        return;
      }
      yield {
        type: "text",
        text:
          finished && !hasScript
            ? "Skill script was unavailable; nothing ran."
            : declined
              ? "Skill was declined; nothing ran."
              : finished
                ? task.includes("Save output")
                  ? "Approved skill completed; FUSE saved only kept-result.txt through the approved output mapping."
                  : "Approved skill completed in isolated Python. No project files changed."
                : "The selected package script requires your approval.",
      };
      if (!finished && options.tools?.some((t) => t.name === "run_skill_script"))
        yield {
          type: "tool_call",
          call: {
            id: "recorded-skill-call",
            name: "run_skill_script",
            input: {
              version_id: versionId,
              path: "scripts/calculate.py",
              args: ["literal; $(no shell)"],
              timeout_seconds: 30,
              keep: task.includes("Save output")
                ? [{ from: "result.txt", to: "kept-result.txt" }]
                : null,
            },
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
        stopReason: finished ? "end_turn" : "tool_use",
        providerRequestId: null,
        attempts: 1,
        turn: { provider, model, items: [] },
      };
    },
  };
}
