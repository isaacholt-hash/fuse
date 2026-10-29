/**
 * One chat exported (CH-11): Markdown of the branch on screen (also copied, or made into a PDF),
 * or JSON with every branch, its models and costs. Never keys.
 */
import type { Message } from "@/storage/messages";
import type { Thread } from "@/storage/threads";

export type ThreadExportFormat = "copy" | "md" | "pdf" | "json";

/** The whole chat as JSON: every message on every branch, and which one is on screen. */
export function threadJson(thread: Thread, all: readonly Message[], now = Date.now()): string {
  return `${JSON.stringify(
    {
      format: "fuse-chat",
      version: 1,
      exported_at: new Date(now).toISOString(),
      chat: {
        id: thread.id,
        title: thread.title,
        created_at: new Date(thread.createdAt).toISOString(),
        instructions: thread.instructions,
        tags: thread.tags,
        active_leaf_id: thread.activeLeafId,
        cost_micro_usd: thread.costMicroUsd,
      },
      messages: all.map((m) => ({
        id: m.id,
        parent_id: m.parentId,
        role: m.role,
        content: m.content,
        provider: m.provider,
        model: m.model,
        status: m.status,
        created_at: new Date(m.createdAt).toISOString(),
        input_tokens: m.usage.inputTokens,
        output_tokens: m.usage.outputTokens,
        cost_micro_usd: m.usage.costMicroUsd,
        ...(m.route ? { route: m.route } : {}),
      })),
    },
    null,
    2,
  )}\n`;
}
