/** Shared desktop/web controls. Execution belongs to the desktop loop or HULK's runner. */
import { useEffect, useRef, useState } from "react";
import type { ChatDeps } from "@/chat/sendMessage";
import type { Catalog, ProviderId } from "@/catalog/catalog";
import { storedRouting } from "@/catalog/stored";
import type { RoutingPolicy } from "@/routing/policy";
import type { RouteMode } from "@/routing/route";
import { egressRefusal, projectPolicy, threadPolicy, type EgressPolicy } from "@/context/egress";
import { inScope } from "@/memory/inject";
import { listMemories } from "@/storage/memories";
import { listMessages } from "@/storage/messages";
import { listArtifacts } from "@/storage/artifacts";
import { getThread } from "@/storage/threads";
import { runsForThread } from "@/storage/runs";
import { uuidv7 } from "@/storage/ids";
import { askToStartWithId, askToContinueResearch, askToPauseResearch } from "@/storage/runQueue";
import { hulkDb, type HulkApi, type HulkStatus } from "@/handover/api";
import { openExternal } from "@/ui/openExternal";
import {
  ResearchSetup,
  ResearchTask,
  ContinueResearch,
  type ResearchContextOption,
  type ResearchSetupChoice,
} from "@/ui/Research";
import { researchModels } from "./routing";
import { startResearchRun, continueResearchRun, type ResearchDeps } from "./engine";
import { requestControl, ensureResearchChat } from "./storage";
import { researchStatus, type ResearchTaskView } from "./status";
import { captureTransfer, RESEARCH_PROTOCOL } from "./transfer";
import {
  remoteResearchLinks,
  remoteResearchStatus,
  startRemoteResearch,
  stopQueuedResearch,
  type RemoteResearchLink,
} from "./remote";

interface Setup {
  requestId: string;
  newThreadId: string;
  draftInstructions: string;
  sourceId: string | null;
  projectId: string | null;
  scope: string;
  context: ResearchContextOption[];
  policy: EgressPolicy;
  hulkStatus: HulkStatus | null;
  hulkProviders: ProviderId[];
  hulkCatalog: Catalog;
  hulkPolicy: RoutingPolicy;
  hulkReason: string | null;
  error: string | null;
  busy: boolean;
}
interface Options {
  deps: ChatDeps;
  threadId: string | null;
  projectId: string | null;
  mode: RouteMode;
  policy: RoutingPolicy;
  providers: readonly ProviderId[];
  hulk?: HulkApi;
  hulkStatus: HulkStatus | null;
  web: boolean;
  incognito: boolean;
  draftInstructions?: string;
  onChanged: (threadId: string) => void;
  onSelect: (threadId: string, draft: string) => void;
  onError: (error: unknown) => void;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Research could not be validated.";
function ownerDeps(deps: ChatDeps, onChanged?: (threadId: string) => void): ResearchDeps {
  let first = true;
  return {
    db: deps.db,
    tenant: deps.tenant,
    catalog: deps.catalog,
    adapterFor: deps.adapterFor,
    ...(deps.web ? { web: deps.web } : {}),
    onProgress: (progress) => {
      if (first && progress.run.threadId) {
        first = false;
        onChanged?.(progress.run.threadId);
      }
    },
  };
}
export function useResearch(options: Options) {
  const { deps, threadId, projectId, hulk, web } = options;
  const [setup, setSetup] = useState<Setup | null>(null),
    [taskState, setTaskState] = useState<{ threadId: string | null; rows: ResearchTaskView[] }>({
      threadId: null,
      rows: [],
    }),
    [links, setLinks] = useState<RemoteResearchLink[]>([]);
  const [resume, setResume] = useState<{
    task: ResearchTaskView;
    remote: boolean;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const tasks = taskState.threadId === threadId ? taskState.rows : [];
  const controllers = useRef(new Map<string, AbortController>()),
    starting = useRef(false);
  const callbacks = useRef(options),
    changed = useRef(new Map<string, string>());
  useEffect(() => {
    callbacks.current = options;
  });
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
    },
    [],
  );
  useEffect(() => {
    let alive = true;
    void remoteResearchLinks(deps.db, deps.tenant).then(
      (rows) => {
        if (alive) setLinks(rows);
      },
      (error: unknown) => {
        if (alive) callbacks.current.onError(error);
      },
    );
    return () => {
      alive = false;
    };
  }, [deps.db, deps.tenant]);
  const linksKey = links
    .filter((link) => link.sourceThreadId === threadId)
    .map((link) => link.requestId)
    .join();
  useEffect(() => {
    if (!threadId) {
      return;
    }
    const life = { gone: false };
    const gone = () => life.gone;
    let busy = false;
    const poll = async () => {
      if (busy || gone()) return;
      busy = true;
      try {
        const found: ResearchTaskView[] = [];
        for (const entry of (await runsForThread(deps.db, deps.tenant, threadId)).values()) {
          if (entry.run.kind !== "research") continue;
          const task = await researchStatus(
            deps.db,
            deps.tenant,
            entry.run.id,
            web ? "hulk" : "desktop",
          );
          if (task) found.push(task);
        }
        if (web) {
          const queued = await deps.db.select<{
            id: string;
            task: string;
            cap: number;
            status: string;
            error: string | null;
          }>(
            "SELECT id,json_extract(input,'$.task') task,json_extract(input,'$.capMicroUsd') cap,status,error FROM run_requests WHERE workspace_id=? AND user_id=? AND kind='start' AND json_extract(input,'$.kind')='research' AND json_extract(input,'$.threadId')=? AND run_id IS NULL ORDER BY created_at",
            [deps.tenant.workspaceId, deps.tenant.userId, threadId],
          );
          for (const row of queued) {
            if (!found.some((task) => task.id === row.id))
              found.push({
                id: row.id,
                threadId,
                title: row.task,
                status: row.status === "failed" ? "error" : "queued",
                stage: null,
                searches: null,
                reads: null,
                modelCalls: null,
                spentMicroUsd: 0,
                heldMicroUsd: 0,
                unknownMicroUsd: 0,
                capMicroUsd: row.cap,
                note: row.error ?? "Waiting for HULK's runner.",
                readOnly: false,
                location: "hulk",
                pauseRequested: false,
              });
          }
        }
        for (const link of links.filter((link) => link.sourceThreadId === threadId)) {
          if (!hulk) continue;
          try {
            found.push(await remoteResearchStatus(hulk, deps.tenant, link, deps.db));
          } catch (error) {
            found.push({
              id: link.requestId,
              threadId: link.targetThreadId,
              title: link.task,
              status: "error",
              stage: null,
              searches: null,
              reads: null,
              modelCalls: null,
              spentMicroUsd: 0,
              heldMicroUsd: 0,
              unknownMicroUsd: 0,
              capMicroUsd: link.capMicroUsd,
              note: errorText(error),
              readOnly: false,
              location: "hulk",
              pauseRequested: false,
              statusUnknown: true,
            });
          }
        }
        if (gone()) return;
        setTaskState((old) =>
          old.threadId === threadId && JSON.stringify(old.rows) === JSON.stringify(found)
            ? old
            : { threadId, rows: found },
        );
        for (const task of found) {
          const mark = `${task.status}:${task.stage ?? ""}`;
          if (changed.current.get(task.id) !== mark) {
            changed.current.set(task.id, mark);
            callbacks.current.onChanged(threadId);
          }
        }
      } catch (error) {
        if (!gone()) callbacks.current.onError(error);
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      life.gone = true;
      clearInterval(timer);
    };
    // Links are read through their stable ID key; changing their delivery label cannot execute them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.db, deps.tenant, threadId, hulk, web, linksKey]);
  const open = (scope: string) => {
    if (options.incognito) return;
    void (async () => {
      const sourceId = threadId,
        policy = sourceId
          ? await threadPolicy(deps.db, deps.tenant, sourceId)
          : await projectPolicy(deps.db, deps.tenant, projectId);
      const source = sourceId ? await getThread(deps.db, deps.tenant, sourceId) : null;
      const context: ResearchContextOption[] = [];
      if (source?.memoryOn !== false) {
        for (const memory of (await listMemories(deps.db, deps.tenant))
          .filter((memory) => memory.maySend && inScope(memory, { projectId, threadId: sourceId }))
          .slice(0, 64))
          context.push({
            id: memory.id,
            kind: "memoryIds",
            label: `${memory.kind}: ${memory.text.slice(0, 120)}`,
          });
      }
      if (sourceId) {
        for (const artifact of (await listArtifacts(deps.db, deps.tenant, sourceId)).slice(0, 64))
          context.push({
            id: artifact.id,
            kind: "artifactIds",
            label: `Artifact: ${artifact.title} · version ${String(artifact.version)}`,
          });
        for (const message of (await listMessages(deps.db, deps.tenant, sourceId))
          .filter(
            (message) =>
              message.status !== "streaming" &&
              (message.role === "user" || message.role === "assistant"),
          )
          .slice(-64))
          context.push({
            id: message.id,
            kind: "messageIds",
            label: `${message.role === "user" ? "You" : "Assistant"}: ${message.content.slice(0, 100)}`,
          });
      }
      let status = options.hulkStatus,
        hulkReason: string | null = null,
        hulkCatalog = deps.catalog,
        hulkPolicy = options.policy;
      const hulkProviders: ProviderId[] = [];
      const flags = sourceId
        ? (
            await deps.db.select<{ local_only: number }>(
              "SELECT local_only FROM threads WHERE workspace_id=? AND id=?",
              [deps.tenant.workspaceId, sourceId],
            )
          )[0]
        : null;
      if (web) hulkProviders.push(...options.providers);
      else if (policy.mode === "local_only" || flags?.local_only === 1)
        hulkReason = "This context is kept on this device and cannot be transferred to HULK.";
      else if (!hulk) hulkReason = "Pair with HULK in desktop Settings first.";
      else {
        try {
          status = await hulk.status();
          hulkReason = !status.paired
            ? "Pair with HULK in Settings first."
            : (status.mismatch ??
              (status.server?.researchProtocol !== RESEARCH_PROTOCOL
                ? "Update HULK to a build with Research before starting there."
                : null));
          if (!hulkReason && projectId) {
            const projects = await hulkDb(hulk).select(
              "SELECT id FROM projects WHERE workspace_id=? AND id=? AND deleted_at IS NULL",
              [deps.tenant.workspaceId, projectId],
            );
            if (!projects.length)
              hulkReason =
                "This project is not on HULK yet. Let its enrolled sync finish, or choose this computer.";
          }
          if (!hulkReason) {
            const stored = await storedRouting(hulkDb(hulk), deps.tenant, projectId);
            const ownerPolicy = await projectPolicy(hulkDb(hulk), deps.tenant, projectId);
            hulkCatalog = stored.catalog;
            hulkPolicy = stored.policy;
            for (const provider of ["openai", "anthropic"] as const) {
              const state = await hulk.invoke<{ saved: boolean }>("key_status", { provider });
              if (
                state.saved &&
                egressRefusal(policy, provider, "chat") === null &&
                egressRefusal(ownerPolicy, provider, "chat") === null
              )
                hulkProviders.push(provider);
            }
            try {
              researchModels(hulkCatalog, hulkPolicy, options.mode, scope, hulkProviders);
            } catch (error) {
              hulkReason = errorText(error);
            }
          }
        } catch (error) {
          hulkReason = errorText(error);
        }
      }
      setSetup({
        requestId: uuidv7(),
        newThreadId: uuidv7(),
        draftInstructions: options.draftInstructions ?? "",
        sourceId,
        projectId,
        scope,
        context,
        policy,
        hulkStatus: status,
        hulkProviders,
        hulkCatalog,
        hulkPolicy,
        hulkReason,
        error: null,
        busy: false,
      });
    })().catch(options.onError);
  };
  const start = async (choice: ResearchSetupChoice) => {
    if (!setup || starting.current) return;
    starting.current = true;
    setSetup((value) => (value ? { ...value, busy: true, error: null } : null));
    try {
      const models = researchModels(
        choice.location === "hulk" ? setup.hulkCatalog : deps.catalog,
        choice.location === "hulk" ? setup.hulkPolicy : options.policy,
        options.mode,
        choice.task,
        choice.location === "hulk" ? setup.hulkProviders : options.providers,
      );
      let sourceId = setup.sourceId;
      if (!sourceId) {
        sourceId = await ensureResearchChat(deps, {
          id: setup.newThreadId,
          projectId: setup.projectId,
          task: choice.task,
          instructions: setup.draftInstructions,
          mode: options.mode,
        });
        setSetup((value) => (value ? { ...value, sourceId } : null));
        callbacks.current.onSelect(sourceId, setup.scope);
      }
      if (choice.location === "hulk" && !web) {
        if (!hulk) throw new Error("HULK is unavailable.");
        const transfer = await captureTransfer(deps, sourceId, choice.task, choice.selection, [
          models.worker.provider,
          models.best.provider,
        ]);
        const link = await startRemoteResearch(
          { db: deps.db, tenant: deps.tenant, hulk },
          {
            requestId: setup.requestId,
            task: choice.task,
            models,
            capMicroUsd: choice.capMicroUsd,
            transfer,
          },
        );
        setLinks((old) =>
          old.some((item) => item.requestId === link.requestId) ? old : [...old, link],
        );
        setSetup(null);
        callbacks.current.onChanged(sourceId);
        return;
      }
      if (choice.location === "desktop" && web)
        throw new Error("Browsers cannot execute research on this computer.");
      if (web) {
        await askToStartWithId(deps.db, deps.tenant, setup.requestId, {
          threadId: sourceId,
          projectId: setup.projectId,
          task: choice.task,
          kind: "research",
          model: { provider: models.worker.provider, id: models.worker.id },
          planner: { provider: models.best.provider, id: models.best.id },
          capMicroUsd: choice.capMicroUsd,
          research: { protocol: 1, selection: choice.selection, pinned: models.pinned },
        });
      } else {
        const controller = new AbortController();
        controllers.current.set(setup.requestId, controller);
        const id = sourceId;
        void startResearchRun(
          ownerDeps(deps, (thread) => {
            callbacks.current.onChanged(thread);
          }),
          {
            requestId: setup.requestId,
            threadId: id,
            task: choice.task,
            worker: models.worker,
            best: models.best,
            capMicroUsd: choice.capMicroUsd,
            location: "desktop",
            selection: choice.selection,
            pinned: models.pinned,
          },
          controller.signal,
        )
          .catch((error: unknown) => {
            callbacks.current.onError(error);
          })
          .finally(() => {
            controllers.current.delete(setup.requestId);
            callbacks.current.onChanged(id);
          });
      }
      setSetup(null);
      callbacks.current.onChanged(sourceId);
    } catch (error) {
      setSetup((value) => (value ? { ...value, busy: false, error: errorText(error) } : null));
    } finally {
      starting.current = false;
    }
  };
  const remoteFor = (task: ResearchTaskView) => links.find((link) => link.requestId === task.id);
  const control = (task: ResearchTaskView, action: "pause" | "stop") => {
    const link = remoteFor(task),
      db = link && hulk ? hulkDb(hulk) : deps.db;
    void (async () => {
      if (web || link) {
        if (action === "pause") await askToPauseResearch(db, deps.tenant, task.id);
        else await stopQueuedResearch(db, deps.tenant, task.id);
      } else {
        await requestControl({ db, tenant: deps.tenant }, task.id, action);
        if (action === "stop") controllers.current.get(task.id)?.abort();
      }
      if (threadId) callbacks.current.onChanged(threadId);
    })().catch(options.onError);
  };
  const continueTask = async (capMicroUsd: number) => {
    if (!resume || resume.busy) return;
    const current = resume;
    setResume({ ...current, busy: true, error: null });
    try {
      const link = remoteFor(current.task);
      if (web || link) {
        if (link && !hulk) throw new Error("Pair with the original HULK to continue.");
        await askToContinueResearch(
          link && hulk ? hulkDb(hulk) : deps.db,
          deps.tenant,
          current.task.id,
          capMicroUsd,
        );
      } else {
        const controller = new AbortController();
        controllers.current.set(current.task.id, controller);
        void continueResearchRun(ownerDeps(deps), current.task.id, {
          capMicroUsd,
          signal: controller.signal,
        })
          .catch((error: unknown) => {
            callbacks.current.onError(error);
          })
          .finally(() => {
            controllers.current.delete(current.task.id);
            if (current.task.threadId) callbacks.current.onChanged(current.task.threadId);
          });
      }
      setResume(null);
    } catch (error) {
      setResume({ ...current, busy: false, error: errorText(error) });
    }
  };
  const locations = {
    desktop: web
      ? "Browsers cannot execute research on this computer. Open the desktop app to run locally."
      : null,
    hulk: setup?.hulkReason ?? null,
  };
  const preferred = web || locations.hulk === null ? "hulk" : "desktop";
  return {
    open,
    hasDialog: setup !== null || resume !== null,
    stopCurrent: (requestedId?: string) => {
      if (requestedId && controllers.current.has(requestedId)) {
        void requestControl({ db: deps.db, tenant: deps.tenant }, requestedId, "stop")
          .then(() => {
            controllers.current.get(requestedId)?.abort();
          })
          .catch(options.onError);
        return true;
      }
      const active = tasks.filter(
        (task) =>
          !remoteFor(task) &&
          !task.readOnly &&
          (task.status === "running" || task.status === "queued"),
      );
      for (const task of active) control(task, "stop");
      return active.length > 0;
    },
    reason: options.incognito
      ? "Research keeps durable progress and reports. Use a normal Chat; incognito content is excluded."
      : null,
    busy: tasks.some((task) => !remoteFor(task) && task.status === "running"),
    progress: (
      <div className="max-h-56 shrink-0 overflow-y-auto" aria-label="Research tasks">
        {tasks.map((task) => (
          <ResearchTask
            key={task.id}
            task={task}
            onPause={() => {
              control(task, "pause");
            }}
            onStop={() => {
              control(task, "stop");
            }}
            onContinue={() => {
              setResume({ task, remote: Boolean(remoteFor(task)), busy: false, error: null });
            }}
            {...(remoteFor(task)
              ? {
                  onOpen: () => {
                    const link = remoteFor(task);
                    if (link)
                      openExternal(
                        `${link.address}/?thread=${encodeURIComponent(link.targetThreadId)}`,
                      );
                  },
                }
              : {})}
          />
        ))}
      </div>
    ),
    dialogs: (
      <>
        {setup && (
          <ResearchSetup
            remoteCreatesChat={!web}
            initialScope={setup.scope}
            initialLocation={preferred}
            locations={locations}
            context={setup.context}
            preview={(scope, location) =>
              researchModels(
                location === "hulk" ? setup.hulkCatalog : deps.catalog,
                location === "hulk" ? setup.hulkPolicy : options.policy,
                options.mode,
                scope,
                location === "hulk" ? setup.hulkProviders : options.providers,
              )
            }
            busy={setup.busy}
            error={setup.error}
            onCancel={() => {
              if (!starting.current) setSetup(null);
            }}
            onStart={(choice) => {
              void start(choice);
            }}
          />
        )}
        {resume && (
          <ContinueResearch
            capMicroUsd={resume.task.capMicroUsd}
            error={resume.error}
            busy={resume.busy}
            onCancel={() => {
              if (!resume.busy) setResume(null);
            }}
            onContinue={(cap) => {
              void continueTask(cap);
            }}
          />
        )}
      </>
    ),
  };
}
