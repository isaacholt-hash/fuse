// The egress policy (SE-13): which providers may receive a project's content, and in what form.
// The app checks it on every path that sends (router, chat, compare, failover, housekeeping,
// embeddings); the Rust transport checks it again (M5 step 9).
import type { EmbeddingModel, ProviderId } from "@/catalog/catalog";
import type { SendScope } from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import { listEgressRules, type EgressRule } from "@/storage/egress";
import { getProject, type PrivacyMode, type Project } from "@/storage/projects";
import type { SqlDb } from "@/storage/sql";
import { getThread } from "@/storage/threads";

const NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  local: "the local model",
};

export interface EgressPolicy {
  /** null: a chat outside any project, under the global rules only. */
  projectName: string | null;
  mode: PrivacyMode;
  /** Providers nothing may be sent to. */
  blocked: ProviderId[];
  /** Whether content may be sent to a provider to be embedded for search. */
  embeddings: boolean;
}

export const OPEN_POLICY: EgressPolicy = {
  projectName: null,
  mode: "normal",
  blocked: [],
  embeddings: true,
};

/** The policy for a project (or none): its own rule for a provider wins over the global one. */
export function policyFor(
  project: Pick<Project, "id" | "name" | "privacyMode" | "allowEmbeddings"> | null,
  rules: readonly EgressRule[],
): EgressPolicy {
  const providers = [...new Set(rules.map((r) => r.provider))];
  const blocked = providers.filter((p) => {
    const own = project ? rules.find((r) => r.projectId === project.id && r.provider === p) : null;
    const global = rules.find((r) => r.projectId === null && r.provider === p);
    return !(own ?? global ?? { allow: true }).allow;
  });
  return {
    projectName: project?.name ?? null,
    mode: project?.privacyMode ?? "normal",
    blocked,
    embeddings: project?.allowEmbeddings ?? true,
  };
}

export type EgressPurpose = "chat" | "housekeeping" | "embeddings";

/** Why nothing may go to `provider` for this purpose, in plain words; null when it may. */
export function egressRefusal(
  policy: EgressPolicy,
  provider: ProviderId,
  purpose: EgressPurpose,
): string | null {
  const where = policy.projectName ? `The project “${policy.projectName}”` : "Your settings";
  // LL-04: the local model never leaves this computer, so only Cloud only refuses it.
  if (provider === "local") {
    return policy.mode === "cloud_only"
      ? `${where} is set to Cloud only, so the local model isn't used.`
      : null;
  }
  if (policy.mode === "local_only") {
    return `${where} is set to Local only, so nothing is sent to a cloud model. FUSE has no local model yet, so it can't answer here; change the privacy mode in the project's settings to send.`;
  }
  if (policy.blocked.includes(provider)) {
    return `${where} blocks ${NAMES[provider]}, so nothing was sent to it. Pick a model from another provider, or allow ${NAMES[provider]} in privacy settings.`;
  }
  if (purpose === "embeddings" && !policy.embeddings) {
    return `${where} doesn't allow sending its content to be embedded for search.`;
  }
  return null;
}

/** The embedding model to use under this policy, or null when content may not be embedded. */
export const allowedEmbedding = (
  policy: EgressPolicy,
  model: EmbeddingModel | null | undefined,
): EmbeddingModel | null =>
  model && egressRefusal(policy, model.provider, "embeddings") === null ? model : null;

/** The policy for one project, read fresh. */
export async function projectPolicy(
  db: SqlDb,
  tenant: Tenant,
  projectId: string | null,
): Promise<EgressPolicy> {
  const project = projectId ? await getProject(db, tenant, projectId) : null;
  return policyFor(project, await listEgressRules(db, tenant));
}

/** The policy for a request's scope (SE-13), read fresh. */
export async function scopePolicy(
  db: SqlDb,
  tenant: Tenant,
  scope: SendScope,
): Promise<EgressPolicy> {
  return scope.kind === "thread"
    ? threadPolicy(db, tenant, scope.id)
    : projectPolicy(db, tenant, scope.kind === "project" ? scope.id : null);
}

/** The policy for the project a chat is in (or the global rules), read fresh. */
export async function threadPolicy(
  db: SqlDb,
  tenant: Tenant,
  threadId: string | null,
): Promise<EgressPolicy> {
  const thread = threadId ? await getThread(db, tenant, threadId) : null;
  return projectPolicy(db, tenant, thread?.projectId ?? null);
}
