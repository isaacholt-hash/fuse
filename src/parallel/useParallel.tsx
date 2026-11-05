import { useEffect, useMemo, useRef, useState } from "react";
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import { getRun, type Run } from "@/storage/runs";
import type { GitApi } from "@/repo/git";
import { ParallelReviewDialog, type ParallelDialogState } from "@/ui/ParallelRuns";
import type { ChildCommitPin, ParallelApi, ParallelView } from "./types";
import { parallelProgress, stopParallelChild } from "./progress";

interface Options {
  db: SqlDb;
  tenant: Tenant;
  roots: readonly Run[];
  threadId: string | null;
  git: GitApi | undefined;
  onChanged: () => void;
  onError: (error: unknown) => void;
}
function fullApi(git: GitApi | undefined): ParallelApi | undefined {
  if (
    !git?.reviewChild ||
    !git.planIntegration ||
    !git.applyChildReview ||
    !git.childAttempts ||
    !git.discardChildReview
  )
    return;
  return {
    reviewChild: git.reviewChild.bind(git),
    planIntegration: git.planIntegration.bind(git),
    applyChildReview: git.applyChildReview.bind(git),
    childAttempts: git.childAttempts.bind(git),
    discardChildReview: git.discardChildReview.bind(git),
  };
}
/** Native command failures reject with a string on Tauri and the shared web bridge. */
export function parallelError(error: unknown, fallback: string): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string" && error.trim()
      ? error
      : fallback;
}
export function useParallelRuns(options: Options) {
  const { db, tenant, threadId } = options;
  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });
  const api = useMemo(() => fullApi(options.git), [options.git]);
  const [views, setViews] = useState<Map<string, ParallelView>>(new Map());
  const [dialog, setDialog] = useState<ParallelDialogState | null>(null);
  const opening = useRef(false);
  const viewKey = useRef("");
  const rootsKey = options.roots
    .filter((r) => !r.parentRunId && r.kind === "code")
    .map((r) => r.id)
    .sort()
    .join("|");
  useEffect(() => {
    let live = true;
    let reading = false;
    let reported = false;
    const ids = rootsKey ? rootsKey.split("|") : [];
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await parallelProgress(db, tenant, ids);
        const key = JSON.stringify([...next]);
        if (live && key !== viewKey.current) {
          viewKey.current = key;
          setViews(next);
        }
      } catch (error) {
        if (live && !reported) {
          reported = true;
          callbacks.current.onError(error);
        }
      } finally {
        reading = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [db, tenant, rootsKey, threadId]);
  const root = (parentId: string) => {
    const found = callbacks.current.roots.find((r) => r.id === parentId);
    if (!found || found.readOnly || found.status === "running")
      throw new Error("Finish this run and use its execution owner’s review controls.");
    if (!api)
      throw new Error(
        "Reviewed integration is unavailable on this installation. Update the execution owner.",
      );
    return api;
  };
  const open = async (parentId: string, childId?: string) => {
    if (opening.current || dialog) return;
    opening.current = true;
    const origin = callbacks.current.threadId;
    const state: ParallelDialogState = {
      parentId,
      selecting: !childId,
      busy: true,
      attempts: [],
      snapshot: null,
      result: null,
      error: null,
    };
    setDialog(state);
    try {
      const owner = root(parentId);
      state.attempts = await owner.childAttempts(parentId);
      if (state.attempts.some((a) => a.state === "working"))
        throw new Error(
          "A previous repository attempt needs review. Inspect its retained result and release the interrupted claim explicitly.",
        );
      if (childId) state.snapshot = await owner.reviewChild(parentId, childId);
      if (callbacks.current.threadId === origin) setDialog({ ...state, busy: false });
      else setDialog(null);
    } catch (error) {
      if (callbacks.current.threadId === origin)
        setDialog({
          ...state,
          busy: false,
          error: parallelError(error, "Couldn't review retained work."),
        });
      else setDialog(null);
    } finally {
      opening.current = false;
    }
  };
  const prepare = async (commits: ChildCommitPin[]) => {
    if (!dialog || dialog.busy) return;
    const state = dialog;
    setDialog({ ...state, busy: true, error: null });
    try {
      const snapshot = await root(state.parentId).planIntegration(state.parentId, commits);
      setDialog({ ...state, snapshot, busy: false, error: null });
    } catch (error) {
      setDialog({
        ...state,
        busy: false,
        error: parallelError(error, "Couldn't prepare integration."),
      });
    }
  };
  const apply = async () => {
    if (!dialog?.snapshot || dialog.busy) return;
    const state = dialog;
    const token = dialog.snapshot.id;
    setDialog({ ...state, busy: true, error: null });
    try {
      const owner = root(state.parentId);
      const result = await owner.applyChildReview(token);
      const attempts = await owner.childAttempts(state.parentId);
      setDialog({ ...state, result, attempts, busy: false, error: null });
      callbacks.current.onChanged();
    } catch (error) {
      // Never retry a repository mutation on an ambiguous acknowledgement.
      const attempts =
        (await api?.childAttempts(state.parentId).catch(() => state.attempts)) ?? state.attempts;
      const completed = attempts.find(
        (a) => a.id === token && (a.state === "committed" || a.state === "complete") && a.result,
      );
      if (completed?.result) {
        setDialog({
          ...state,
          result: completed.result,
          attempts,
          busy: false,
          error: null,
          notice:
            "Completion was confirmed from the execution owner’s retained record after an interrupted response.",
        });
        callbacks.current.onChanged();
        return;
      }
      setDialog({
        ...state,
        snapshot: null,
        attempts,
        busy: false,
        error: parallelError(
          error,
          "The outcome is unknown. Inspect retained work; no action was replayed.",
        ),
      });
    }
  };
  const release = async (token: string) => {
    if (!dialog || dialog.busy) return;
    const state = dialog;
    setDialog({ ...state, busy: true, error: null });
    try {
      const owner = root(state.parentId);
      await owner.discardChildReview(state.parentId, token);
      const attempts = await owner.childAttempts(state.parentId);
      setDialog({ ...state, selecting: true, snapshot: null, attempts, busy: false, error: null });
    } catch (error) {
      setDialog({
        ...state,
        busy: false,
        error: parallelError(error, "Couldn't release the interrupted claim."),
      });
    }
  };
  const close = () => {
    if (!dialog || dialog.busy) return;
    const state = dialog;
    setDialog(null);
    if (state.snapshot && !state.result)
      void api
        ?.discardChildReview(state.parentId, state.snapshot.id)
        .catch(callbacks.current.onError);
  };
  const stopChild = async (childId: string) => {
    try {
      const child = await getRun(db, tenant, childId);
      if (
        !child?.parentRunId ||
        child.readOnly ||
        child.status !== "running" ||
        !callbacks.current.roots.some((r) => r.id === child.parentRunId && !r.readOnly)
      )
        throw new Error("Stop this child through its execution owner.");
      if (!(await stopParallelChild(db, tenant, child.parentRunId, childId)))
        throw new Error(
          "The child owner or scope changed. Refresh its history before using controls.",
        );
      callbacks.current.onChanged();
    } catch (error) {
      callbacks.current.onError(error);
    }
  };
  return {
    views,
    hasDialog: Boolean(dialog),
    available: Boolean(api),
    review: (parentId: string, childId: string) => {
      void open(parentId, childId);
    },
    integrate: (parentId: string) => {
      void open(parentId);
    },
    stopChild: (childId: string) => {
      void stopChild(childId);
    },
    dialog: dialog ? (
      <ParallelReviewDialog
        state={dialog}
        onClose={close}
        onPlan={(pins) => {
          void prepare(pins);
        }}
        onApply={() => {
          void apply();
        }}
        onRelease={(token) => {
          void release(token);
        }}
      />
    ) : null,
  };
}
