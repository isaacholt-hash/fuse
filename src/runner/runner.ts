// The runner (M10 step 6, CA-15): runs on HULK, started by fuse-server, so a run keeps going
// with every page closed. It takes what pages ask for from the database (run_requests), runs
// chats' runs with the same loop as the desktop, and parks each approval there as "Waiting for
// you" until some signed-in page answers it.
import { findModel, type CatalogModel, type ProviderId } from "@/catalog/catalog";
import { continueChatRun, startChatRun } from "@/agent/chatRun";
import type { ApprovalAnswer, ApprovalRequest, RunDeps, RunProgress } from "@/agent/run";
import {
  addApproval,
  approvalAnswer,
  answerApproval,
  askToStart,
  closeOpenApprovals,
  failTakenRequests,
  finishRequest,
  setLive,
  takeRequest,
  type Handover,
  type ModelRef,
  type RunRequest,
} from "@/storage/runQueue";
import { readFuseExport, applyRestore } from "@/data/restore";
import { cloneOnServer } from "@/handover/api";
import { grantFolder, linkThreadFolder } from "@/storage/folders";
import {
  getRun,
  listSteps,
  markInterruptedRuns,
  setRunStatus,
  type Run,
  type RunStep,
} from "@/storage/runs";
import { dueSchedules, markStarted, setScheduleOutcome, setScheduleRun } from "@/storage/schedules";
import { createThread } from "@/storage/threads";

export interface RunnerOptions {
  /** What every run gets, built fresh for each (keys may have been added since); not `approve`. */
  deps: () => Promise<RunDeps>;
  /** How often a waiting run checks for its answer. */
  pollMs?: number;
  /** How often the streaming text is saved for pages to show. */
  liveMs?: number;
  /** Tests pass fakes. */
  start?: typeof startChatRun;
  continue?: typeof continueChatRun;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** M10 step 7: the server's clone of a handed-over run's repository (tests pass a fake). */
  clone?: (remote: string, branch: string) => Promise<string>;
  /** The clock scheduled tasks go by; tests pass a fake. */
  now?: () => number;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class Runner {
  /** Runs going now, by run id, so Stop can reach them. */
  readonly going = new Map<string, AbortController>();
  /** Everything started, so tests (and shutdown) can wait for it. */
  private readonly work = new Set<Promise<void>>();
  private readonly pollMs: number;
  private readonly liveMs: number;
  private readonly start: typeof startChatRun;
  private readonly continue: typeof continueChatRun;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(private readonly options: RunnerOptions) {
    this.pollMs = options.pollMs ?? 1000;
    this.liveMs = options.liveMs ?? 500;
    this.start = options.start ?? startChatRun;
    this.continue = options.continue ?? continueChatRun;
    this.sleep = options.sleep ?? wait;
    this.log = options.log ?? (() => {});
  }

  /**
   * At start: runs that were going when the server stopped are marked stopped (Continue picks
   * them up; nothing reruns on its own), requests that were being handled fail, and questions
   * left open count as no.
   */
  async recover(): Promise<void> {
    const { db, tenant } = await this.options.deps();
    const runs = await markInterruptedRuns(db, tenant);
    // Their answers stop streaming too, so the chat shows them as cut off.
    await db.execute(
      `UPDATE messages SET status = 'stopped', error_code = 'interrupted', updated_at = ?
       WHERE workspace_id = ? AND status = 'streaming'
         AND id IN (SELECT message_id FROM runs WHERE workspace_id = ? AND status = 'stopped')`,
      [Date.now(), tenant.workspaceId, tenant.workspaceId],
    );
    const requests = await failTakenRequests(db, tenant);
    const questions = await closeOpenApprovals(db, tenant);
    if (runs + requests + questions > 0)
      this.log(
        `recovered: ${String(runs)} runs, ${String(requests)} requests, ${String(questions)} questions`,
      );
  }

  /** Starts the scheduled tasks that are due, then handles every request waiting now. */
  async tick(): Promise<void> {
    const base = await this.options.deps();
    await this.startDue(base);
    for (;;) {
      const request = await takeRequest(base.db, base.tenant);
      if (!request) return;
      await this.handle(request).catch(async (e: unknown) => {
        await finishRequest(base.db, base.tenant, request.id, { error: message(e) });
      });
    }
  }

  /** Waits for everything started so far to finish (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.all([...this.work]);
  }

  /** Stops every run going (shutdown); each is left stopped, to be continued. */
  stopAll(): void {
    for (const c of this.going.values()) c.abort();
  }

  /**
   * AG-07: each due task gets a new chat in its project, named for it, and a start request like
   * any page's. A time missed while the server was off isn't made up; the next one is set.
   */
  private async startDue(base: RunDeps): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    for (const s of await dueSchedules(base.db, base.tenant, now)) {
      const when = new Date(now).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const thread = await createThread(
        base.db,
        base.tenant,
        `${s.name} · ${when}`,
        s.projectId,
        false,
        s.kind,
      );
      await markStarted(base.db, base.tenant, s, thread.id, now);
      await askToStart(base.db, base.tenant, {
        threadId: thread.id,
        projectId: s.projectId,
        task: s.prompt,
        model: { provider: s.provider, id: s.model },
        mode: s.mode,
        kind: s.kind,
        capMicroUsd: s.capMicroUsd,
        scheduleId: s.id,
      });
      this.log(`started the scheduled task ${s.name}`);
    }
  }

  /** How a scheduled task's run ended; a run that didn't finish says its last step. */
  private async scheduleOutcome(deps: RunDeps, scheduleId: string, runId: string): Promise<void> {
    const run = await getRun(deps.db, deps.tenant, runId);
    if (!run) return;
    const last = (await listSteps(deps.db, deps.tenant, runId)).at(-1);
    const note =
      run.status === "done"
        ? null
        : [run.note, last ? `Last step: ${describeStep(last)}` : null].filter(Boolean).join(" ");
    await setScheduleOutcome(deps.db, deps.tenant, scheduleId, run.status, note || null);
  }

  private track(p: Promise<void>): void {
    const t = p.finally(() => this.work.delete(t));
    this.work.add(t);
  }

  private async handle(request: RunRequest): Promise<void> {
    const base = await this.options.deps();
    const { db, tenant } = base;
    if (request.kind === "stop") {
      const going = this.going.get(request.input.runId);
      if (going) going.abort();
      else {
        // M10 step 11: nothing here is running it (a stale row, or another process's), so Stop
        // still works: the record says stopped, and Continue can pick it up.
        const run = await getRun(db, tenant, request.input.runId);
        if (run?.status === "running")
          await setRunStatus(db, tenant, run.id, "stopped", "Stopped from another session.");
      }
      await finishRequest(db, tenant, request.id, { runId: request.input.runId });
      return;
    }
    const controller = new AbortController();
    const deps = this.withApprovals(base);
    if (request.kind === "continue") {
      const { runId, raiseCapBy } = request.input;
      if (this.going.has(runId)) throw new Error("That run is already going.");
      this.going.set(runId, controller);
      await finishRequest(db, tenant, request.id, { runId });
      this.track(
        this.continue(deps, runId, {
          ...(raiseCapBy ? { raiseCapBy } : {}),
          signal: controller.signal,
          onProgress: this.live(deps),
        }).then(
          (run) => this.ended(deps, run.id),
          (e: unknown) => this.failed(deps, runId, e),
        ),
      );
      return;
    }
    const input = request.input;
    const scheduleId = input.scheduleId;
    let model: CatalogModel;
    let planner: CatalogModel | null;
    try {
      model = modelFor(base, input.model);
      planner = input.planner ? modelFor(base, input.planner) : null;
    } catch (e) {
      if (scheduleId) await setScheduleOutcome(db, tenant, scheduleId, "error", message(e));
      throw e;
    }
    const handed = input.handover ? await this.takeOver(base, input.handover, input) : null;
    const threadId = handed?.threadId ?? input.threadId;
    if (!threadId) throw new Error("No chat to run in.");
    let runId: string | null = null;
    const live = this.live(deps);
    this.track(
      this.start(deps, {
        threadId,
        projectId: input.projectId,
        task: input.task,
        model,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.newBranch ? { newBranch: true } : {}),
        planner,
        ...(input.capMicroUsd !== undefined ? { capMicroUsd: input.capMicroUsd } : {}),
        signal: controller.signal,
        onProgress: (answerId, p) => {
          if (runId === null) {
            runId = p.run.id;
            this.going.set(runId, controller);
            void finishRequest(db, tenant, request.id, { runId }).catch(() => {});
            if (scheduleId) void setScheduleRun(db, tenant, scheduleId, runId).catch(() => {});
          }
          live(answerId, p);
        },
      })
        .then(
          async (run: Run) => {
            if (handed && input.handover)
              await this.push(deps, run.id, handed.folderId, input.handover);
            await this.ended(deps, run.id);
          },
          async (e: unknown) => {
            if (runId) await this.failed(deps, runId, e);
            else {
              await finishRequest(db, tenant, request.id, { error: message(e) });
              if (scheduleId) await setScheduleOutcome(db, tenant, scheduleId, "error", message(e));
            }
          },
        )
        .then(async () => {
          if (scheduleId && runId) await this.scheduleOutcome(deps, scheduleId, runId);
        }),
    );
  }

  /**
   * A handover: the desktop's project is restored here (same ids; what's already here is kept),
   * the repository is cloned or fetched into the server's own copy, and the run gets a new chat
   * in the project with only that copy as its folder (the project's other folders are the
   * desktop's).
   */
  private async takeOver(
    base: RunDeps,
    handover: Handover,
    input: { projectId: string | null; task: string },
  ): Promise<{ threadId: string; folderId: string }> {
    const { db, tenant } = base;
    if (!base.files) throw new Error("The server has no file store for the project's export.");
    const parsed = await readFuseExport(await base.files.get(handover.exportSha));
    await applyRestore(db, tenant, parsed, base.files);
    const path = await (this.options.clone ?? cloneOnServer)(handover.remote, handover.branch);
    const folder = await grantFolder(db, tenant, path);
    const title = input.task.replace(/\s+/g, " ").trim().slice(0, 60) || "Handed over";
    // M10 step 12: a handed-over run is a Code session.
    const thread = await createThread(
      db,
      tenant,
      `${title} (from the desktop)`,
      input.projectId,
      false,
      "code",
    );
    await linkThreadFolder(db, tenant, thread.id, folder.id);
    this.log(`took over a run on ${handover.remote} (${handover.branch})`);
    return { threadId: thread.id, folderId: folder.id };
  }

  /**
   * A handed-over run that finished on its branch asks to commit what it changed and push the
   * branch (one send), then says how. Nobody is at the desktop to commit, so HULK does.
   */
  private async push(deps: RunDeps, runId: string, folderId: string, handover: Handover) {
    const run = await getRun(deps.db, deps.tenant, runId);
    const git = deps.git;
    if (run?.status !== "done" || !run.branch || !git || !deps.approve) return;
    const branch = run.branch;
    const changed = (await git.run(folderId, "git", ["status", "--porcelain"])).output.trim();
    const head = (await git.run(folderId, "git", ["rev-parse", "HEAD"])).output.trim();
    const base = (
      await git.run(folderId, "git", ["rev-parse", `origin/${handover.branch}`])
    ).output.trim();
    if (!changed && head === base) {
      await setRunStatus(deps.db, deps.tenant, runId, "done", "Nothing to push: no files changed.");
      return;
    }
    const yes = await deps.approve({
      kind: "git",
      summary: `${changed ? "Commit and push" : "Push"} ${branch} to ${handover.remote}`,
      remote: true,
      runId,
    });
    const note = async (): Promise<string> => {
      if (yes !== "yes" && yes !== "always" && yes !== true)
        return `Not pushed: ${branch} is on HULK's copy only.`;
      if (changed) {
        const add = await git.run(folderId, "git", ["add", "-A"]);
        const message = run.task.replace(/\s+/g, " ").trim().slice(0, 72) || "Run on HULK";
        const commit =
          add.exitCode === 0 ? await git.run(folderId, "git", ["commit", "-m", message]) : add;
        if (commit.exitCode !== 0) return `Couldn't commit on ${branch}: ${commit.output.trim()}`;
      }
      const r = await git.run(folderId, "git", ["push", "-u", "origin", branch]);
      return r.exitCode === 0
        ? `Pushed ${branch} to ${handover.remote}.`
        : `Couldn't push ${branch}: ${r.output.trim()}`;
    };
    await setRunStatus(deps.db, deps.tenant, runId, "done", await note());
  }

  /** Saves the streaming text every `liveMs`, and always when a turn ends. */
  private live(deps: RunDeps): (answerId: string, p: RunProgress) => void {
    let last = 0;
    let saved = "";
    return (_answerId, p) => {
      const now = Date.now();
      if (p.streaming === saved || (p.streaming !== "" && now - last < this.liveMs)) return;
      last = now;
      saved = p.streaming;
      void setLive(deps.db, deps.tenant, p.run.id, p.streaming).catch(() => {});
    };
  }

  private async ended(deps: RunDeps, runId: string): Promise<void> {
    this.going.delete(runId);
    await setLive(deps.db, deps.tenant, runId, "");
  }

  private async failed(deps: RunDeps, runId: string, e: unknown): Promise<void> {
    this.log(`run ${runId} failed: ${message(e)}`);
    await this.ended(deps, runId);
  }

  /** The run's questions wait in the database until a page answers, or the run is stopped. */
  private withApprovals(base: RunDeps): RunDeps {
    return {
      ...base,
      approve: async (req: ApprovalRequest): Promise<ApprovalAnswer> => {
        const { signal, ...question } = req;
        const id = await addApproval(base.db, base.tenant, req.runId, question);
        for (;;) {
          const got = await approvalAnswer(base.db, base.tenant, id);
          if (got) return got.answer as ApprovalAnswer;
          if (signal?.aborted) {
            await answerApproval(base.db, base.tenant, id, "no");
            return "no";
          }
          await this.sleep(this.pollMs);
        }
      },
    };
  }
}

function modelFor(deps: RunDeps, ref: ModelRef): CatalogModel {
  const m = findModel(deps.catalog, ref.provider as ProviderId, ref.id);
  if (!m) throw new Error(`The model ${ref.provider}/${ref.id} isn't in FUSE's list.`);
  return m;
}

/** A step in a few words, for a failed scheduled task: the tool and the start of its result. */
function describeStep(step: RunStep): string {
  const text = step.kind === "tool" ? `${step.call.name}: ${step.output}` : step.text;
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 200)}…` : one || "(empty)";
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
