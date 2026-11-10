import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { diffLines } from "@/artifacts/diff";
import { DiffView } from "./Artifacts";
import { Modal, Money } from "./primitives";
import { shortBranch } from "@/parallel/branch";
import type {
  ChildCommitPin,
  ChildReviewAttempt,
  ChildReviewResult,
  ChildReviewSnapshot,
  ParallelView,
} from "@/parallel/types";

export function ParallelRuns({
  view,
  readOnly,
  parentRunning,
  onReview,
  onIntegrate,
  onStop,
}: {
  view: ParallelView;
  readOnly: boolean;
  parentRunning: boolean;
  onReview?: (childId: string) => void;
  onIntegrate?: () => void;
  onStop?: (childId: string) => void;
}) {
  const active = parentRunning || view.children.some((c) => c.status === "running");
  const finished = view.children.filter((c) => c.status === "done").length;
  // Retention is worth saying while children work or when one stopped early, not after a clean run.
  const interrupted = view.children.some((c) => c.status !== "done" && c.status !== "running");
  // The run's total also covers the parent's own planning, so the children's share is their rows' sum.
  const childrenMicro = view.children.reduce((sum, c) => sum + c.spentMicroUsd, 0);
  return (
    <section aria-label="Parallel tasks" className="mt-3 space-y-2 border-t pt-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-medium">
          Parallel tasks · {view.children.length}
          {!active && finished > 0 && (
            <span className="text-[12px] font-normal text-muted-foreground">
              {" "}
              · {finished} done, each in its own worktree
            </span>
          )}
        </h2>
        {!readOnly && onIntegrate && (
          // The one next step once the children finish; outline while they still work.
          <Button
            size="sm"
            variant={active ? "outline" : "default"}
            className="h-7 text-[12px]"
            disabled={active}
            onClick={onIntegrate}
          >
            Review integration
          </Button>
        )}
      </div>
      <p className="text-[12px] text-muted-foreground">
        Children spent <Money micro={childrenMicro} />
        {view.spentMicroUsd > childrenMicro && (
          <>
            {" "}
            of the run&apos;s <Money micro={view.spentMicroUsd} className="font-normal" />
          </>
        )}
        {view.heldMicroUsd > 0 && (
          <>
            {" "}
            · <Money micro={view.heldMicroUsd} className="font-normal" /> set aside for work still
            running
          </>
        )}
      </p>
      {readOnly && (
        <p className="text-[12px] text-muted-foreground">
          Retained history. Review and integration controls are available on the execution owner.
        </p>
      )}
      <ol className="divide-y">
        {view.children.map((child, index) => (
          <li key={child.id} className="py-2 first:pt-0 last:pb-0" data-parallel-child={child.id}>
            <div className="flex flex-wrap items-start gap-2">
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-[12px]">
                {index + 1}. {child.task}
              </span>
              <span className="text-[12px] text-muted-foreground">
                {child.status === "running"
                  ? "Working"
                  : child.status === "done"
                    ? "Done"
                    : child.status === "error"
                      ? "Failed"
                      : child.status === "stopped"
                        ? "Stopped"
                        : "Paused"}
              </span>
              <Money micro={child.spentMicroUsd} className="text-[13px] leading-[18px]" />
            </div>
            {child.note && (
              <p className="mt-1 whitespace-pre-wrap text-[12px] text-muted-foreground">
                {child.note}
              </p>
            )}
            <Details summary={`${String(child.steps)} steps`}>
              {child.branch && (
                <p className="font-mono text-[12px]" title={child.branch}>
                  {shortBranch(child.branch)}
                </p>
              )}
              {child.latest && <p className="break-words">Latest: {child.latest}</p>}
              {child.plan && (
                <>
                  <p className="text-foreground">
                    Plan{child.planner ? ` · ${child.planner}` : ""}
                  </p>
                  <PlanText plan={child.plan} />
                </>
              )}
            </Details>
            {!readOnly && (
              <div className="mt-1.5 flex flex-wrap gap-2">
                {child.status === "running" && onStop && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[12px]"
                    aria-label={`Stop child ${String(index + 1)}`}
                    onClick={() => {
                      onStop(child.id);
                    }}
                  >
                    Stop child
                  </Button>
                )}
                {onReview && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[12px]"
                    aria-label={`Review changes, child ${String(index + 1)}`}
                    disabled={active}
                    onClick={() => {
                      onReview(child.id);
                    }}
                  >
                    Review changes
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {(active || interrupted) && (
        <p className="text-[12px] text-muted-foreground">
          Children share this run’s owner and cap. Interrupted tasks stay retained; Continue never
          restarts them automatically.
        </p>
      )}
    </section>
  );
}

/** A plan written "1. … 2. … 3. …" on one line reads as a numbered list. */
function PlanText({ plan }: { plan: string }) {
  const steps = plan
    .split(/(?:^|\s)(?=\d+\.\s)/)
    .map((s) => s.replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);
  if (steps.length < 2 || !/^\s*1\.\s/.test(plan))
    return <p className="break-words whitespace-pre-wrap">{plan}</p>;
  return (
    <ol className="list-decimal space-y-0.5 pl-5 break-words">
      {steps.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
  );
}

/** A quiet fold for run plumbing (branch, plan, steps): closed by default, one click away. */
export function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group mt-1 text-[12px] text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded hover:text-foreground pointer-coarse:min-h-6 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        {summary}
      </summary>
      <div className="mt-1 space-y-1 pl-4">{children}</div>
    </details>
  );
}

export interface ParallelDialogState {
  parentId: string;
  selecting: boolean;
  busy: boolean;
  attempts: ChildReviewAttempt[];
  snapshot: ChildReviewSnapshot | null;
  result: ChildReviewResult | null;
  error: string | null;
  notice?: string;
}
export function ParallelReviewDialog({
  state,
  onClose,
  onPlan,
  onApply,
  onRelease,
}: {
  state: ParallelDialogState;
  onClose: () => void;
  onPlan: (commits: ChildCommitPin[]) => void;
  onApply: () => void;
  onRelease: (token: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const commits = new Map<string, ChildReviewAttempt>();
  for (const attempt of state.attempts) {
    if (
      attempt.kind === "child" &&
      attempt.childId &&
      attempt.result &&
      (attempt.state === "committed" || attempt.state === "failed") &&
      !commits.has(attempt.childId)
    )
      commits.set(attempt.childId, attempt);
  }
  const choosing = state.selecting && !state.snapshot && !state.result;
  const integration = state.selecting || state.snapshot?.childId === null;
  return (
    <Modal
      open
      wide
      title={
        state.result
          ? "Reviewed repository change complete"
          : integration
            ? "Review integration"
            : "Review child changes"
      }
      description={
        state.result
          ? "The approved commit is retained on this execution owner."
          : "Review the pinned revisions and diff before approving a repository change."
      }
      onOpenChange={(open) => {
        if (!open && !state.busy) onClose();
      }}
    >
      <div className="space-y-3 text-xs">
        {state.busy && (
          <p role="status">
            {state.snapshot
              ? "Finishing the approved repository change…"
              : "Reading retained work…"}
          </p>
        )}
        {state.notice && (
          <p role="status" className="text-muted-foreground">
            {state.notice}
          </p>
        )}
        {state.error && (
          <p role="alert" className="whitespace-pre-wrap text-destructive">
            {state.error}
          </p>
        )}
        {choosing && (
          <>
            <p>
              Select exact child commits. Conflicting edits or changed parent/child inputs pause
              integration.
            </p>
            {commits.size === 0 && (
              <p className="text-muted-foreground">
                Review and commit at least one child’s changes first.
              </p>
            )}
            {[...commits].map(([childId, attempt]) => (
              <label key={childId} className="flex items-start gap-2 rounded border p-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label={`Select commit ${attempt.result?.commit ?? ""}`}
                  disabled={state.busy}
                  checked={selected.has(childId)}
                  onChange={(e) => {
                    setSelected((old) => {
                      const next = new Set(old);
                      if (e.target.checked) next.add(childId);
                      else next.delete(childId);
                      return next;
                    });
                  }}
                />
                <span className="min-w-0">
                  <span className="block break-all font-mono">{attempt.result?.branch}</span>
                  <span className="block break-all font-mono text-muted-foreground">
                    {attempt.result?.commit}
                  </span>
                  {attempt.state === "failed" && (
                    <span className="block text-warning">
                      Retained after an interrupted acknowledgement; native verification is
                      required.
                    </span>
                  )}
                </span>
              </label>
            ))}
            <Button
              disabled={state.busy || selected.size === 0}
              onClick={() => {
                onPlan(
                  [...selected].flatMap((childId) => {
                    const commit = commits.get(childId)?.result?.commit;
                    return commit ? [{ childId, commit }] : [];
                  }),
                );
              }}
            >
              Review selected commits
            </Button>
          </>
        )}
        {state.snapshot && !state.result && (
          <>
            <p className="break-all">
              Parent revision <code>{state.snapshot.parentBase.commit}</code>
            </p>
            {state.snapshot.childHead && (
              <p className="break-all">
                Child revision <code>{state.snapshot.childHead}</code>
              </p>
            )}
            {state.snapshot.commits.map((pin) => (
              <p className="break-all font-mono" key={pin.childId}>
                Child commit {pin.commit}
              </p>
            ))}
            <p>
              {state.snapshot.childId
                ? "This commits only the reviewed child changes."
                : "This creates a separate integration branch and worktree from the exact child commits. The original folder and index are preserved."}{" "}
              Commits use FUSE &lt;fuse@local&gt; as author and committer.
            </p>
            <div className="max-h-[45vh] space-y-3 overflow-auto" aria-label="Reviewed child diffs">
              {state.snapshot.files.map((file) => (
                <section key={file.path}>
                  <h3 className="mb-1 break-all font-mono text-xs">
                    {file.path} ·{" "}
                    {file.after === null ? "deleted" : file.before === null ? "new" : "changed"} ·{" "}
                    {file.mode === "100755" ? "executable" : "regular file"}
                  </h3>
                  <DiffView lines={diffLines(file.before ?? "", file.after ?? "")} />
                </section>
              ))}
            </div>
            <Button disabled={state.busy} onClick={onApply}>
              {state.snapshot.childId ? "Commit reviewed child" : "Approve integration branch"}
            </Button>
          </>
        )}
        {state.result && (
          <div role="status" className="space-y-2 rounded border p-3">
            <p className="font-medium">
              {integration
                ? "Integration branch is ready for review."
                : "Reviewed child commit created."}
            </p>
            <p className="break-all font-mono">{state.result.branch}</p>
            <p className="break-all font-mono">{state.result.commit}</p>
            <p className="break-all">Worktree: {state.result.path}</p>
            <p className="text-muted-foreground">
              Use the existing Code/Git workflow to review this branch or explicitly link its
              worktree for another task. Nothing starts automatically.
            </p>
          </div>
        )}
        {state.attempts
          .filter((a) => a.state === "working" || (a.state === "failed" && a.result))
          .map((a) => (
            <div key={a.id} className="space-y-2 rounded border p-2">
              <p>
                A previous {a.kind === "child" ? "child commit" : "integration"} attempt has an
                unacknowledged outcome. Its evidence is retained; it will not replay.
              </p>
              {a.result && (
                <p className="break-all font-mono">
                  {a.result.branch} · {a.result.commit}
                </p>
              )}
              {a.state === "working" && (
                <Button
                  variant="outline"
                  disabled={state.busy}
                  onClick={() => {
                    onRelease(a.id);
                  }}
                >
                  Keep evidence and release interrupted claim
                </Button>
              )}
            </div>
          ))}
        <div className="flex justify-end">
          <Button variant="outline" disabled={state.busy} onClick={onClose}>
            {state.result ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
