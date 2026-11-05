import type { RunDeps, RunInput } from "@/agent/run";
import { foldersFor } from "@/agent/folders";
import { egressRefusal, projectPolicy } from "@/context/egress";
import type { ReviewFile, ReviewSnapshot, ReviewSource } from "./types";
import { integer, object, safePath, sha, string, validateSnapshot } from "./validate";

const sensitive = (path: string) =>
  path
    .split("/")
    .some((part) =>
      /^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|credentials(?:\.json)?$|secrets\.json$|id_(?:rsa|ed25519|ecdsa))|\.(?:pem|key|p12|pfx|keystore)$/i.test(
        part,
      ),
    );

/** Resolve a user-selected PR URL using only this project's enabled built-in reader. */
export async function githubSource(
  deps: RunDeps,
  where: Pick<RunInput, "projectId" | "threadId" | "model">,
  serverId: string,
  url: string,
  signal?: AbortSignal,
): Promise<Extract<ReviewSource, { kind: "github" }>> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enter a GitHub pull request URL.");
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(parsed.pathname);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password ||
    !match
  )
    throw new Error("Enter an HTTPS github.com pull request URL.");
  const source: Extract<ReviewSource, { kind: "github" }> = {
    kind: "github",
    serverId,
    installationId: 1,
    owner: match[1] ?? "",
    repo: match[2] ?? "",
    number: integer(Number(match[3])),
  };
  await permitted(deps, where, source, where.model.provider);
  if (!deps.mcp) throw new Error("GitHub readers are unavailable.");
  const mcp = deps.mcp,
    tools = await mcp.tools(serverId);
  if (
    !["github_installations", "github_repositories"].every((name) =>
      tools.some((tool) => tool.name === name && tool.readOnly),
    )
  )
    throw new Error("This account cannot list its selected repositories.");
  let calls = 0;
  const read = async (name: string, args: Record<string, unknown>) => {
    signal?.throwIfAborted();
    if (++calls > 20)
      throw new Error(
        "Repository discovery reached its twenty-page bound. Narrow this App's selected repositories and try again.",
      );
    await permitted(deps, where, source, where.model.provider);
    const result = await mcp.call(serverId, name, args, {
      projectId: where.projectId,
      threadId: where.threadId,
      provider: where.model.provider,
    });
    signal?.throwIfAborted();
    const text = result.parts
      .filter((p) => p.kind === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    if (result.isError || text.length > 524288)
      throw new Error("GitHub repository discovery failed.");
    const value = object(JSON.parse(text) as unknown);
    if (!Array.isArray(value.items) || value.items.length > 10)
      throw new Error("GitHub returned an invalid repository selection page.");
    return value;
  };
  let installsCursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const installs = await read(
      "github_installations",
      installsCursor ? { cursor: installsCursor } : {},
    );
    for (const raw of installs.items as unknown[]) {
      const install = object(raw);
      if (install.usable !== true) continue;
      source.installationId = integer(install.installationId, Number.MAX_SAFE_INTEGER);
      let cursor: string | null = null;
      for (let repoPage = 0; repoPage < 10; repoPage++) {
        const repos = await read("github_repositories", {
          installationId: source.installationId,
          ...(cursor ? { cursor } : {}),
        });
        if (
          (repos.items as unknown[]).some(
            (item) =>
              String(object(item).fullName).toLowerCase() ===
              `${source.owner}/${source.repo}`.toLowerCase(),
          )
        )
          return source;
        if (repos.nextCursor === null) break;
        cursor = string(repos.nextCursor, 200);
      }
    }
    if (installs.nextCursor === null) break;
    installsCursor = string(installs.nextCursor, 200);
  }
  throw new Error(
    "This pull request's repository is not selected for the enabled GitHub account within the discovery bound.",
  );
}

export async function permitted(
  deps: RunDeps,
  where: Pick<RunInput, "projectId" | "threadId">,
  source: ReviewSource,
  provider: string,
): Promise<void> {
  const { workspaceId: ws, userId: user } = deps.tenant;
  if (
    where.projectId &&
    !(
      await deps.db.select<{ id: string }>(
        "SELECT id FROM projects WHERE id=? AND workspace_id=? AND user_id=? AND deleted_at IS NULL",
        [where.projectId, ws, user],
      )
    ).length
  )
    throw new Error("The review project is unavailable.");
  if (
    where.threadId &&
    !(
      await deps.db.select<{ id: string }>(
        "SELECT id FROM threads WHERE id=? AND workspace_id=? AND user_id=? AND deleted_at IS NULL",
        [where.threadId, ws, user],
      )
    ).length
  )
    throw new Error("The review chat is unavailable.");
  const policy = await projectPolicy(deps.db, deps.tenant, where.projectId);
  if (provider !== "openai" && provider !== "anthropic")
    throw new Error("Review requires an eligible cloud provider.");
  const refused = egressRefusal(policy, provider, "chat");
  if (refused) throw new Error(refused);
  if (source.kind !== "github") {
    if (!(await foldersFor(deps, where)).some((f) => f.id === source.folderId))
      throw new Error("The selected folder is no longer linked to this review's chat or project.");
    return;
  }
  if (!where.projectId || !deps.mcp || policy.mode === "local_only")
    throw new Error(
      "GitHub review needs an explicitly enabled account in a cloud-permitted project on this installation.",
    );
  const builtin = await deps.db.select<{ id: string }>(
    "SELECT id FROM mcp_servers WHERE workspace_id=? AND user_id=? AND id=? AND builtin_kind='github' AND deleted_at IS NULL",
    [ws, user, source.serverId],
  );
  if (
    !builtin.length ||
    !(await deps.mcp.forProject(where.projectId)).some((s) => s.id === source.serverId)
  )
    throw new Error("Enable this built-in GitHub account for the selected project first.");
}
export async function captureReview(
  deps: RunDeps,
  input: Pick<RunInput, "projectId" | "threadId" | "model">,
  source: ReviewSource,
): Promise<ReviewSnapshot> {
  await permitted(deps, input, source, input.model.provider);
  if (source.kind !== "github") {
    if (!deps.git?.snapshot)
      throw new Error("Pinned local review is unavailable on this execution owner.");
    return validateSnapshot(
      await deps.git.snapshot(source.folderId, {
        kind: source.kind,
        ...(source.kind === "branch" ? { baseRef: source.baseRef, headRef: source.headRef } : {}),
      }),
    );
  }
  if (!deps.mcp) throw new Error("GitHub readers are unavailable.");
  const mcp = deps.mcp;
  const tools = await mcp.tools(source.serverId);
  const names = ["github_pull_read", "github_diff_read", "github_file_read"];
  if (!names.every((name) => tools.some((tool) => tool.name === name && tool.readOnly)))
    throw new Error("This account does not offer the required read-only GitHub readers.");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(source.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(source.repo))
    throw new Error("Choose a valid GitHub owner and repository.");
  integer(source.installationId, Number.MAX_SAFE_INTEGER);
  integer(source.number);
  const common = { installationId: source.installationId, owner: source.owner, repo: source.repo };
  const call = async (name: string, args: Record<string, unknown>) => {
    await permitted(deps, input, source, input.model.provider);
    const result = await mcp.call(
      source.serverId,
      name,
      { ...common, ...args },
      { projectId: input.projectId, threadId: input.threadId, provider: input.model.provider },
    );
    const text = result.parts
      .filter((p) => p.kind === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    if (result.isError || text.length > 524288)
      throw new Error("The bounded GitHub reader failed. No review request was sent.");
    return object(JSON.parse(text) as unknown);
  };
  const pull = await call("github_pull_read", { number: source.number });
  if (!sha(pull.baseCommit) || !sha(pull.headCommit))
    throw new Error("GitHub omitted pinned pull request revisions.");
  const base = pull.baseCommit,
    head = pull.headCommit;
  let mergeBase: string | null = null,
    total = 0;
  const files: ReviewFile[] = [],
    limitations: string[] = [];
  const read = async (path: string, commit: string): Promise<string> => {
    const file = await call("github_file_read", { commit, path, startLine: 1 });
    if (
      file.commit !== commit ||
      file.path !== path ||
      file.partial ||
      file.nextLine !== null ||
      !Array.isArray(file.lines) ||
      file.lines.length > 1000
    )
      throw new Error(
        "The pinned file exceeds the first 1,000 lines / 30,000 characters capture limit.",
      );
    const text = file.lines
      .map((raw: unknown, index: number) => {
        const line = object(raw);
        if (line.line !== index + 1 || typeof line.text !== "string")
          throw new Error("GitHub returned invalid numbered source lines.");
        return line.text;
      })
      .join("\n");
    if (new TextEncoder().encode(text).length > 65536)
      throw new Error("The pinned file exceeds 64 KiB.");
    return text;
  };
  for (const offset of [0, 10]) {
    const diff = await call("github_diff_read", { base, head, offset });
    if (
      diff.baseCommit !== base ||
      diff.headCommit !== head ||
      !sha(diff.mergeBaseCommit) ||
      (mergeBase !== null && mergeBase !== diff.mergeBaseCommit) ||
      !Array.isArray(diff.files) ||
      diff.files.length > 10
    )
      throw new Error("The comparison changed or returned malformed pinned evidence.");
    mergeBase = diff.mergeBaseCommit;
    if (diff.partial)
      limitations.push(
        "GitHub supplied partial comparison evidence; unavailable files or patches were excluded.",
      );
    for (const rawFile of diff.files) {
      const file = object(rawFile),
        path = string(file.path, 1024);
      if (!safePath(path)) throw new Error("GitHub returned an unsafe review path.");
      if (
        sensitive(path) ||
        (typeof file.previousPath === "string" && sensitive(file.previousPath))
      ) {
        limitations.push("A secret-looking repository path was excluded.");
        continue;
      }
      if (file.partial || !Array.isArray(file.lines)) {
        limitations.push(`${path}: no complete patch was available.`);
        continue;
      }
      try {
        const oldPath = typeof file.previousPath === "string" ? file.previousPath : path;
        if (!safePath(oldPath)) throw new Error("Unsafe previous path.");
        const oldText = file.status === "added" ? null : await read(oldPath, mergeBase);
        const newText = file.status === "removed" ? null : await read(path, head);
        const size = new TextEncoder().encode((oldText ?? "") + (newText ?? "")).length;
        if (total + size > 262144) {
          limitations.push(`${path}: the 256 KiB total source limit was reached.`);
          continue;
        }
        total += size;
        const changedOld: number[] = [],
          changedNew: number[] = [];
        for (const rawLine of file.lines) {
          const line = object(rawLine);
          if (line.kind === "removed") changedOld.push(integer(line.oldLine));
          if (line.kind === "added") changedNew.push(integer(line.newLine));
        }
        files.push({
          path,
          oldRevision: mergeBase,
          newRevision: head,
          oldText,
          newText,
          changedOld,
          changedNew,
        });
      } catch (error) {
        limitations.push(
          `${path}: ${error instanceof Error ? error.message : "pinned source unavailable"}`,
        );
      }
    }
    if (diff.nextOffset === null) break;
    if (offset === 10) limitations.push("Only the first twenty comparison files were captured.");
    else if (diff.nextOffset !== 10) throw new Error("Invalid GitHub comparison continuation.");
  }
  if (!mergeBase) throw new Error("GitHub omitted the comparison merge base.");
  await call("github_pull_read", { number: source.number, expectedHead: head });
  const snapshot: ReviewSnapshot = {
    protocol: 1,
    id: "",
    label: `GitHub ${source.owner}/${source.repo} #${String(source.number)} (old side is the merge base)`,
    baseCommit: mergeBase,
    headCommit: head,
    files,
    limitations,
  };
  snapshot.id = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot))),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return validateSnapshot(snapshot);
}
