import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncApi, SyncStatus } from "./api";
/** Polling is independent of the current view. Refresh data without remounting the app. */
export function useSync(api: SyncApi | undefined, onReceived: () => Promise<void>) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const received = useRef(onReceived);
  useEffect(() => {
    received.current = onReceived;
  }, [onReceived]);
  const previous = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.status();
      setStatus(next);
      setError(null);
      if (next.enabled && next.lastSuccessAt !== null && next.lastSuccessAt !== previous.current) {
        previous.current = next.lastSuccessAt;
        await received.current();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (alive)
        timer = setTimeout(() => {
          void tick();
        }, 5000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, refresh]);
  return { status, error, refresh };
}
