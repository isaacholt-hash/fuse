import { useCallback, useEffect, useState } from "react";
import type { UpdateApi } from "@/update/api";

/** Checks at startup and then every few hours, since FUSE tends to stay open all day. */
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

export type UpdateState =
  | { kind: "none" }
  | { kind: "ready"; version: string }
  | { kind: "installing"; version: string }
  | { kind: "failed"; version: string; message: string };

export function useUpdate(api: UpdateApi) {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>({ kind: "none" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    api.version().then(
      (v) => {
        if (alive) setVersion(v);
      },
      () => undefined,
    );
    const look = () => {
      api.prepare().then(
        (next) => {
          if (alive && next)
            setState((s) => (s.kind === "none" ? { kind: "ready", version: next } : s));
        },
        // Offline or GitHub unreachable: try again at the next check, without bothering Isaac.
        (e: unknown) => {
          console.warn("Update check failed", e);
        },
      );
    };
    look();
    const timer = setInterval(look, UPDATE_CHECK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);

  const restart = useCallback(() => {
    if (state.kind !== "ready" && state.kind !== "failed") return;
    const next = state.version;
    setState({ kind: "installing", version: next });
    api.installAndRestart().catch((e: unknown) => {
      setState({ kind: "failed", version: next, message: String(e) });
    });
  }, [api, state]);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  return { version, update: dismissed ? ({ kind: "none" } as const) : state, restart, dismiss };
}
