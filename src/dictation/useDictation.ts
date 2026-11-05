import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { durationCost, speechPrice } from "@/cost/duration";
import type { Recording } from "./capture";
import type { DictationApi } from "./client";
import type { Transcription } from "./api";

export interface DictationConfig {
  api: DictationApi;
  scope: string;
  lifecycleKey: string;
  consent: boolean;
  reason: string | null;
  web: boolean;
  onConsent: (enabled: boolean) => Promise<void>;
  onSettled: () => void;
}
interface Operation {
  controller: AbortController;
  recording: Recording | null;
  finishing: boolean;
  finishRequested: boolean;
}
interface State {
  phase: "idle" | "starting" | "recording" | "transcribing";
  durationMs: number;
  note: string | null;
}
const idle: State = { phase: "idle", durationMs: 0, note: null };

/** Audio belongs to this exact visible composer, never a hidden panel or a newer draft. */
export function useDictation(
  config: DictationConfig | undefined,
  active: boolean,
  insert: (text: string) => void,
) {
  const [state, setState] = useState<State>(idle);
  const operation = useRef<Operation | null>(null);
  const inserted = useRef(new Set<string>());
  const callbacks = useRef({ insert, settled: config?.onSettled });
  useLayoutEffect(() => {
    callbacks.current = { insert, settled: config?.onSettled };
  });
  const cancel = useCallback((update = true) => {
    const op = operation.current;
    operation.current = null;
    op?.controller.abort();
    if (op?.recording) void op.recording.cancel().catch(() => undefined);
    if (update) setState(idle);
  }, []);
  const api = config?.api;
  const scope = config?.scope;
  const consent = config?.consent;
  const reason = config?.reason;
  const lifecycleKey = config?.lifecycleKey;
  useLayoutEffect(() => {
    cancel();
    return () => {
      cancel(false);
    };
  }, [active, consent, reason, lifecycleKey, scope, api, cancel]);
  useEffect(() => {
    const leave = () => {
      cancel();
    };
    const hide = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeunload", leave);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("beforeunload", leave);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [cancel]);
  const finish = useCallback(async () => {
    const op = operation.current;
    if (!op || op.finishing || !api || !scope) return;
    if (!op.recording) {
      op.finishRequested = true;
      return;
    }
    op.finishing = true;
    setState((s) => ({ ...s, phase: "transcribing", note: null }));
    try {
      const bytes = await op.recording.stop();
      if (operation.current !== op) {
        bytes.fill(0);
        return;
      }
      const result: Transcription = await api.transcribe(bytes, scope, true, op.controller.signal);
      if (operation.current !== op || op.controller.signal.aborted) return;
      if (result.text && !inserted.current.has(result.requestId)) {
        inserted.current.add(result.requestId);
        callbacks.current.insert(result.text);
      }
      setState({
        phase: "idle",
        durationMs: result.durationMs,
        note:
          result.billingState === "unknown"
            ? "Billing unresolved. Check request history before trying again."
            : result.text
              ? "Transcript added to your draft. Review it before sending."
              : "No speech returned. Any incurred charge is saved.",
      });
    } catch (error) {
      if (operation.current === op && !op.controller.signal.aborted)
        setState((s) => ({
          ...s,
          phase: "idle",
          note:
            error instanceof Error
              ? error.message
              : "Transcription failed. Check request history before trying again.",
        }));
    } finally {
      // The transport settles incurred costs even if this composer has gone away.
      callbacks.current.settled?.();
      if (operation.current === op) operation.current = null;
    }
  }, [api, scope]);
  const start = async () => {
    if (!api || !consent || reason || !active || operation.current) return;
    const op: Operation = {
      controller: new AbortController(),
      recording: null,
      finishing: false,
      finishRequested: false,
    };
    operation.current = op;
    setState({ ...idle, phase: "starting" });
    try {
      const recording = await api.start(true, op.controller.signal);
      if (operation.current !== op || op.controller.signal.aborted) {
        await recording.cancel();
        return;
      }
      op.recording = recording;
      setState({ ...idle, phase: "recording" });
      if (op.finishRequested) await finish();
    } catch (error) {
      if (operation.current === op) {
        operation.current = null;
        setState({
          ...idle,
          note: error instanceof Error ? error.message : "Couldn't open the microphone.",
        });
      }
    }
  };
  const poll = useEffectEvent(async () => {
    const op = operation.current;
    if (!op?.recording || op.finishing) return;
    try {
      const stillRecording = () => operation.current === op && !op.finishing;
      const status = await op.recording.status();
      if (!stillRecording()) return;
      if (status.phase === "error") {
        cancel();
        setState({ ...idle, note: status.error ?? "Microphone stopped unexpectedly." });
      } else {
        setState((s) => ({ ...s, durationMs: status.durationMs }));
        if (status.phase === "ready" || status.durationMs >= speechPrice.max_duration_ms)
          await finish();
      }
    } catch {
      if (operation.current === op) {
        cancel();
        setState({ ...idle, note: "Recording unavailable. Try again." });
      }
    }
  });
  useEffect(() => {
    if (state.phase !== "recording") return;
    const timer = setInterval(() => {
      void poll();
    }, 200);
    return () => {
      clearInterval(timer);
    };
  }, [state.phase]);
  return {
    ...state,
    busy: state.phase !== "idle",
    start,
    finish,
    cancel: () => {
      cancel();
    },
    estimateMicro: durationCost(Math.ceil(state.durationMs / 1000) * 1000),
  };
}
