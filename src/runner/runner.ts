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
  closeOpenApprovals,
  failTakenRequests,
  finishRequest,
  setLive,
  takeRequest,
  type ModelRef,
  type RunRequest,
} from "@/storage/runQueue";
import { markInterruptedRuns, type Run } from "@/storage/runs";

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

  /** Handles every request waiting now. */
  async tick(): Promise<void> {
    const base = await this.options.deps();
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

  private track(p: Promise<void>): void {
    const t = p.finally(() => this.work.delete(t));
    this.work.add(t);
  }

  private async handle(request: RunRequest): Promise<void> {
    const base = await this.options.deps();
    const { db, tenant } = base;
    if (request.kind === "stop") {
      this.going.get(request.input.runId)?.abort();
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
    const model = modelFor(base, input.model);
    const planner = input.planner ? modelFor(base, input.planner) : null;
    let runId: string | null = null;
    const live = this.live(deps);
    this.track(
      this.start(deps, {
        threadId: input.threadId,
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
            void finishRequest(db, tenant, request.id, { runId });
          }
          live(answerId, p);
        },
      }).then(
        (run: Run) => this.ended(deps, run.id),
        async (e: unknown) => {
          if (runId) await this.failed(deps, runId, e);
          else await finishRequest(db, tenant, request.id, { error: message(e) });
        },
      ),
    );
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

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
