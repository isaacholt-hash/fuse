import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateApi } from "@/update/api";

/**
 * F1 (PL-06): FUSE stays open all day and releases ship several times a day, so it checks every
 * half hour, and again when the window comes back into focus (at most every 5 minutes).
 */
export const UPDATE_CHECK_MS = 30 * 60 * 1000;
export const FOCUS_CHECK_MIN_MS = 5 * 60 * 1000;

export type UpdateState =
  | { kind: "none" }
  | { kind: "ready"; version: string }
  | { kind: "installing"; version: string }
  | { kind: "failed"; version: string; message: string };

/** What "Check for updates" found, for Settings. */
export type CheckResult =
  { kind: "current" } | { kind: "ready"; version: string } | { kind: "failed"; message: string };

export function useUpdate(api: UpdateApi, now: () => number = Date.now) {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>({ kind: "none" });
  /** Dismiss hides the version it was clicked on; a newer release shows again. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lastCheck = useRef(0);
  const running = useRef<Promise<CheckResult> | null>(null);

  /** One check at a time; a newer release than the one downloaded replaces it. */
  const look = useCallback((): Promise<CheckResult> => {
    if (running.current) return running.current;
    lastCheck.current = now();
    const job = api.prepare().then(
      (next): CheckResult => {
        if (!next) return { kind: "current" };
        setState((s) =>
          s.kind === "none" || (s.kind === "ready" && s.version !== next) || s.kind === "failed"
            ? { kind: "ready", version: next }
            : s,
        );
        return { kind: "ready", version: next };
      },
      // Offline or GitHub unreachable: try again at the next check, without bothering Isaac.
      (e: unknown): CheckResult => {
        console.warn("Update check failed", e);
        return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
      },
    );
    running.current = job.finally(() => {
      running.current = null;
    });
    return running.current;
  }, [api, now]);

  useEffect(() => {
    let alive = true;
    api.version().then(
      (v) => {
        if (alive) setVersion(v);
      },
      () => undefined,
    );
    void look();
    const timer = setInterval(() => void look(), UPDATE_CHECK_MS);
    const onFocus = () => {
      if (now() - lastCheck.current >= FOCUS_CHECK_MIN_MS) void look();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [api, look, now]);

  const restart = useCallback(() => {
    if (state.kind !== "ready" && state.kind !== "failed") return;
    const next = state.version;
    setState({ kind: "installing", version: next });
    api.installAndRestart().catch((e: unknown) => {
      setState({ kind: "failed", version: next, message: String(e) });
    });
  }, [api, state]);

  const dismiss = useCallback(() => {
    if (state.kind !== "none") setDismissed(state.version);
  }, [state]);

  const hidden =
    state.kind !== "none" && state.kind !== "installing" && state.version === dismissed;
  return {
    version,
    update: hidden ? ({ kind: "none" } as const) : state,
    restart,
    dismiss,
    /** Settings → "Check for updates": checks now; a found release also shows the bar again. */
    checkNow: async () => {
      const r = await look();
      if (r.kind === "ready") setDismissed(null);
      return r;
    },
  };
}
