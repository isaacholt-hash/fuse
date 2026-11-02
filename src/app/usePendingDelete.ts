// M10 step 18: a delete is marked first and purged a few seconds later, so it can be undone.
// One pending delete at a time: starting another finalises the one before it.
import { useCallback, useEffect, useRef, useState } from "react";

export type PendingDelete =
  | { kind: "thread"; id: string; title: string }
  | {
      kind: "messages";
      threadId: string;
      ids: string[];
      previousLeafId: string | null;
      count: number;
    };

/** What the notice says for a pending delete. */
export function undoLabel(
  pending: { kind: "thread"; title: string } | { kind: "messages"; count: number },
): string {
  if (pending.kind === "thread")
    return pending.title ? `Deleted “${pending.title}”` : "Deleted the chat";
  return pending.count === 1 ? "Deleted 1 answer" : `Deleted ${String(pending.count)} messages`;
}

export interface PendingDeleteHandlers {
  /** Purges the rows for good (the toast ended, was dismissed, or another delete started). */
  finalise: (pending: PendingDelete) => Promise<void>;
  /** Clears the marks and shows the rows again. */
  undo: (pending: PendingDelete) => Promise<void>;
}

export function usePendingDelete(ms: number, handlers: PendingDeleteHandlers) {
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const current = useRef<{ pending: PendingDelete; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  const finish = useCallback((how: keyof PendingDeleteHandlers): Promise<void> => {
    const c = current.current;
    if (!c) return Promise.resolve();
    clearTimeout(c.timer);
    current.current = null;
    setPending(null);
    return latest.current[how](c.pending);
  }, []);
  const start = useCallback(
    async (next: PendingDelete) => {
      await finish("finalise");
      const timer = setTimeout(() => {
        void finish("finalise");
      }, ms);
      current.current = { pending: next, timer };
      setPending(next);
    },
    [finish, ms],
  );
  // Leaving the app (or this screen) ends the undo window: the startup sweep would purge it anyway.
  useEffect(
    () => () => {
      void finish("finalise");
    },
    [finish],
  );
  return {
    pending,
    start,
    undo: useCallback(() => finish("undo"), [finish]),
    flush: useCallback(() => finish("finalise"), [finish]),
  };
}
