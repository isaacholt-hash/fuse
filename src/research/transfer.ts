/** Explicit, bounded context transfer over the existing authenticated native HULK connection. */
import type { ChatDeps } from "@/chat/sendMessage";
import { egressRefusal, threadPolicy, type EgressPolicy } from "@/context/egress";
import type { ProviderId } from "@/catalog/catalog";
import { getThread } from "@/storage/threads";
import { getProject } from "@/storage/projects";
import { selectedContext, validateSelection } from "./context";
import type { ResearchSelection } from "./types";
import config from "../../data/research.json";

export const RESEARCH_PROTOCOL = 1;
export interface ResearchTransfer {
  protocol: 1;
  source: {
    threadId: string;
    projectId: string | null;
    capturedAt: number;
    selection: ResearchSelection;
  };
  project: { id: string; name: string; privacyMode: "normal" | "cloud_only" } | null;
  policy: EgressPolicy;
  context: { system: string; history: { role: "user" | "assistant"; content: string }[] };
  fingerprint: string;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed research context transfer.");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Research context exceeds its bound.");
  return value;
};
const id = (value: unknown): string => {
  const result = text(value, 128);
  if (!result) throw new Error("Missing context source.");
  return result;
};
const nullableId = (value: unknown) => (value === null ? null : id(value));
async function fingerprint(value: Omit<ResearchTransfer, "fingerprint">): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  );
  return Array.from(hash, (n) => n.toString(16).padStart(2, "0")).join("");
}
/** Parse a typed snapshot again on the execution owner; no permissions or arbitrary tool records exist here. */
export async function readTransfer(raw: unknown): Promise<ResearchTransfer> {
  if (new TextEncoder().encode(JSON.stringify(raw)).length > 96000)
    throw new Error("Research transfer exceeds its size bound.");
  const value = object(raw),
    source = object(value.source),
    policy = object(value.policy),
    context = object(value.context);
  if (value.protocol !== RESEARCH_PROTOCOL)
    throw new Error("Update desktop and HULK to the same research protocol.");
  const selection = object(source.selection) as unknown as ResearchSelection;
  validateSelection(selection);
  if (
    !Number.isSafeInteger(source.capturedAt) ||
    typeof source.capturedAt !== "number" ||
    source.capturedAt < 0
  )
    throw new Error("Invalid context capture time.");
  if (
    typeof policy.mode !== "string" ||
    !["normal", "cloud_only"].includes(policy.mode) ||
    !Array.isArray(policy.blocked) ||
    policy.blocked.length > 3 ||
    policy.blocked.some(
      (p) => typeof p !== "string" || !["openai", "anthropic", "local"].includes(p),
    ) ||
    typeof policy.embeddings !== "boolean"
  )
    throw new Error("Invalid research privacy policy.");
  if (
    !Array.isArray(context.history) ||
    context.history.length > config.execution.max_context_items + 1
  )
    throw new Error("Research context has too many messages.");
  const project = value.project === null ? null : object(value.project);
  if (
    project &&
    (typeof project.privacyMode !== "string" ||
      !["normal", "cloud_only"].includes(project.privacyMode))
  )
    throw new Error("Local-only projects cannot transfer to HULK.");
  const clean: Omit<ResearchTransfer, "fingerprint"> = {
    protocol: 1,
    source: {
      threadId: id(source.threadId),
      projectId: nullableId(source.projectId),
      capturedAt: source.capturedAt,
      selection: structuredClone(selection),
    },
    project: project
      ? {
          id: id(project.id),
          name: text(project.name, 512),
          privacyMode: project.privacyMode as "normal" | "cloud_only",
        }
      : null,
    policy: {
      projectName: policy.projectName === null ? null : text(policy.projectName, 512),
      mode: policy.mode as "normal" | "cloud_only",
      blocked: policy.blocked as ProviderId[],
      embeddings: policy.embeddings,
    },
    context: {
      system: text(context.system, config.execution.max_selected_context_chars),
      history: context.history.map((message) => {
        const m = object(message);
        if (m.role !== "user" && m.role !== "assistant")
          throw new Error("Research context cannot contain tools or execution permissions.");
        if (Object.keys(m).some((key) => key !== "role" && key !== "content"))
          throw new Error("Research transfers contain selected text only.");
        return {
          role: m.role,
          content: text(m.content, config.execution.max_selected_context_chars),
        };
      }),
    },
  };
  if ((clean.project?.id ?? null) !== clean.source.projectId)
    throw new Error("Research project context does not match its source.");
  if (
    new TextEncoder().encode(JSON.stringify(clean.context)).length >
    config.execution.max_selected_context_chars
  )
    throw new Error("Select less research context before transferring.");
  const expected = await fingerprint(clean);
  if (value.fingerprint !== expected)
    throw new Error("Research context changed. Review the selection before starting again.");
  return { ...clean, fingerprint: expected };
}
export async function captureTransfer(
  deps: Pick<ChatDeps, "db" | "tenant" | "catalog" | "adapterFor">,
  threadId: string,
  task: string,
  selection: ResearchSelection,
  providers: readonly ProviderId[],
): Promise<ResearchTransfer> {
  const thread = await getThread(deps.db, deps.tenant, threadId);
  if (!thread) throw new Error("Research source Chat is unavailable.");
  const policy = await threadPolicy(deps.db, deps.tenant, threadId);
  for (const provider of providers) {
    const refusal = egressRefusal(policy, provider, "chat");
    if (refusal) throw new Error(refusal);
  }
  const selected = await selectedContext(
    deps,
    threadId,
    task,
    selection,
    providers[0] ?? "openai",
    "hulk",
  );
  const project = thread.projectId
    ? await getProject(deps.db, deps.tenant, thread.projectId)
    : null;
  if (project?.privacyMode === "local_only")
    throw new Error("Local-only content cannot transfer to HULK.");
  const value: Omit<ResearchTransfer, "fingerprint"> = {
    protocol: 1,
    source: {
      threadId,
      projectId: thread.projectId,
      capturedAt: Date.now(),
      selection: structuredClone(selection),
    },
    project: project
      ? { id: project.id, name: project.name, privacyMode: project.privacyMode }
      : null,
    policy,
    context: {
      system: selected.system ?? "",
      history: selected.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    },
  };
  return readTransfer({ ...value, fingerprint: await fingerprint(value) });
}
export async function transferredContext(transfer: ResearchTransfer, provider: ProviderId) {
  const checked = await readTransfer(transfer);
  const refusal = egressRefusal(checked.policy, provider, "chat");
  if (refusal) throw new Error(refusal);
  return { ...checked.context, fingerprint: checked.fingerprint };
}
