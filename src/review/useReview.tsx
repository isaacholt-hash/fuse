import { useEffect, useRef, useState } from "react";
import type { RunDeps, RunProgress } from "@/agent/run";
import { startChatRun } from "@/agent/chatRun";
import { routeForRun, type RouteMode } from "@/routing/route";
import { classify } from "@/routing/classify";
import type { RoutingPolicy } from "@/routing/policy";
import type { ProviderId } from "@/catalog/catalog";
import { createThread, setThreadPins, setThreadSession } from "@/storage/threads";
import { folderName, linkThreadFolder, type Folder } from "@/storage/folders";
import type { StartInput } from "@/storage/runQueue";
import { CodeReviewSetup, type ReviewChoice } from "@/ui/CodeReview";
import { githubSource } from "./source";
interface Options {
  deps: RunDeps | undefined;
  mode: RouteMode;
  policy: RoutingPolicy;
  providers: ProviderId[];
  projectId: string | null;
  projectName: string | null;
  threadId: string | null;
  folders: Folder[];
  web: boolean;
  capMicroUsd: number;
  accountNames: Map<string, string>;
  controllers: Map<string, AbortController>;
  onSelect: (id: string) => void;
  onChanged: (id: string) => void;
  onProgress: (answerId: string, p: RunProgress) => void;
  onError: (error: unknown) => void;
  startOnServer: (input: StartInput, signal: AbortSignal) => Promise<void>;
}
interface Setup {
  draft: string;
  accounts: { id: string; name: string }[];
  busy: boolean;
  error: string | null;
  origin: Options;
}
export function useCodeReview(options: Options) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const callbacks = useRef(options),
    owned = useRef(new Set<AbortController>()),
    opening = useRef(false),
    preparing = useRef<AbortController | null>(null);
  useEffect(() => {
    callbacks.current = options;
  });
  useEffect(
    () => () => {
      for (const c of owned.current) c.abort();
    },
    [],
  );
  const open = async (draft: string) => {
    if (opening.current || setup) return;
    opening.current = true;
    try {
      const origin = callbacks.current,
        deps = origin.deps;
      if (!deps) throw new Error("Code review is unavailable in this build.");
      const accounts = origin.projectId
        ? await deps.db.select<{ id: string; name: string }>(
            `SELECT s.id,s.name FROM mcp_servers s JOIN project_mcp_servers p ON p.server_id=s.id AND p.workspace_id=s.workspace_id AND p.user_id=s.user_id WHERE s.workspace_id=? AND s.user_id=? AND p.project_id=? AND s.builtin_kind='github' AND s.deleted_at IS NULL ORDER BY s.name,s.id`,
            [deps.tenant.workspaceId, deps.tenant.userId, origin.projectId],
          )
        : [];
      setSetup({
        draft,
        accounts: accounts.map((a) => ({
          ...a,
          name: origin.accountNames.get(a.id) ?? `${a.name} · ${a.id.slice(-8)}`,
        })),
        busy: false,
        error: null,
        origin,
      });
    } catch (error) {
      callbacks.current.onError(error);
    } finally {
      opening.current = false;
    }
  };
  const preview = (origin: Options, task: string) => {
    const deps = origin.deps;
    if (!deps) throw new Error("Code review is unavailable.");
    const routed = routeForRun(
      origin.policy,
      deps.catalog,
      origin.mode,
      classify({ text: `Code review: ${task}` }),
      { providers: origin.providers },
    );
    if (!routed.ok) throw new Error(routed.error);
    return routed;
  };
  const start = async (choice: ReviewChoice) => {
    if (!setup || setup.busy) return;
    const origin = setup.origin,
      deps = origin.deps;
    if (!deps) return;
    setSetup({ ...setup, busy: true, error: null });
    let threadId: string | null = null;
    const controller = new AbortController();
    preparing.current = controller;
    owned.current.add(controller);
    try {
      const routed = preview(origin, choice.task);
      const source =
        choice.kind === "github"
          ? await githubSource(
              deps,
              { projectId: origin.projectId, threadId: origin.threadId, model: routed.model },
              choice.serverId,
              choice.url,
              controller.signal,
            )
          : choice.kind === "changes"
            ? { kind: "changes" as const, folderId: choice.folderId }
            : {
                kind: "branch" as const,
                folderId: choice.folderId,
                baseRef: choice.baseRef,
                headRef: choice.headRef,
              };
      if (source.kind !== "github" && !origin.folders.some((f) => f.id === source.folderId))
        throw new Error("Choose a linked folder.");
      controller.signal.throwIfAborted();
      const thread = await createThread(
        deps.db,
        deps.tenant,
        `Review: ${choice.task.slice(0, 70)}`,
        origin.projectId,
        false,
        "code",
      );
      threadId = thread.id;
      await setThreadSession(deps.db, deps.tenant, thread.id, {
        mode: "plan",
        newBranch: false,
        where: origin.web ? "hulk" : "local",
        capMicroUsd: choice.capMicroUsd,
      });
      controller.signal.throwIfAborted();
      await setThreadPins(deps.db, deps.tenant, thread.id, {
        tier: origin.mode.kind === "tier" ? origin.mode.tier : null,
        model:
          origin.mode.kind === "model"
            ? { provider: origin.mode.provider, id: origin.mode.id }
            : null,
      });
      if (source.kind !== "github")
        await linkThreadFolder(deps.db, deps.tenant, thread.id, source.folderId);
      controller.signal.throwIfAborted();
      preparing.current = null;
      if (origin.web) owned.current.delete(controller);
      origin.controllers.set(thread.id, controller);
      if (!origin.web) owned.current.add(controller);
      origin.onChanged(thread.id);
      origin.onSelect(thread.id);
      setSetup(null);
      const planner = routed.info.mode === "auto" ? routed.info.best : null;
      try {
        if (origin.web)
          await origin.startOnServer(
            {
              threadId: thread.id,
              projectId: origin.projectId,
              task: choice.task,
              kind: "code",
              mode: "plan",
              review: source,
              model: { provider: routed.model.provider, id: routed.model.id },
              planner: planner ? { provider: planner.provider, id: planner.id } : null,
              capMicroUsd: choice.capMicroUsd,
            },
            controller.signal,
          );
        else
          await startChatRun(deps, {
            threadId: thread.id,
            projectId: origin.projectId,
            task: choice.task,
            kind: "code",
            mode: "plan",
            review: source,
            model: routed.model,
            planner,
            capMicroUsd: choice.capMicroUsd,
            signal: controller.signal,
            onProgress: (answerId, p) => {
              origin.onProgress(answerId, p);
              origin.onChanged(thread.id);
            },
          });
      } finally {
        owned.current.delete(controller);
        origin.controllers.delete(thread.id);
        origin.onChanged(thread.id);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (threadId) origin.onError(error);
      else
        setSetup((current) =>
          current
            ? {
                ...current,
                busy: false,
                error: error instanceof Error ? error.message : "Review setup failed.",
              }
            : null,
        );
    } finally {
      owned.current.delete(controller);
      if (preparing.current === controller) preparing.current = null;
    }
  };
  let summary = "",
    reason: string | null = null;
  if (setup) {
    try {
      const route = preview(setup.origin, setup.draft);
      summary =
        route.info.mode === "auto"
          ? `${route.info.best?.displayName ?? "Best"} plans and concludes; ${route.model.displayName} reviews.`
          : `${route.model.displayName} for all stages.`;
    } catch (error) {
      reason = error instanceof Error ? error.message : "No eligible review model.";
    }
  }
  return {
    open: (draft: string) => {
      void open(draft);
    },
    hasDialog: setup !== null,
    dialog: setup ? (
      <CodeReviewSetup
        draft={setup.draft}
        folders={setup.origin.folders.map((f) => ({ id: f.id, name: folderName(f.path) }))}
        accounts={setup.accounts}
        projectName={setup.origin.projectName}
        web={setup.origin.web}
        capMicroUsd={setup.origin.capMicroUsd}
        modelSummary={summary}
        preview={(task) => {
          try {
            const route = preview(setup.origin, task);
            return {
              summary:
                route.info.mode === "auto"
                  ? `${route.info.best?.displayName ?? "Best"} plans and concludes; ${route.model.displayName} reviews.`
                  : `${route.model.displayName} for all stages.`,
              reason: null,
            };
          } catch (error) {
            return {
              summary: "",
              reason: error instanceof Error ? error.message : "No eligible review model.",
            };
          }
        }}
        reason={reason}
        busy={setup.busy}
        error={setup.error}
        onCancel={() => {
          preparing.current?.abort();
          setSetup(null);
        }}
        onStart={(choice) => {
          void start(choice);
        }}
      />
    ) : null,
  };
}
