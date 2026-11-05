import { isDesktop, invoke } from "@/platform/core";
import { speechPrice } from "@/cost/duration";
import { encodeRecording } from "./wav";

export interface CaptureStatus {
  phase: "recording" | "ready" | "error";
  durationMs: number;
  bytes: number;
  error?: string | null;
}
export interface Recording {
  status(): Promise<CaptureStatus>;
  stop(): Promise<Uint8Array>;
  cancel(): Promise<void>;
}
const aborted = () => new DOMException("Recording cancelled.", "AbortError");

export interface BrowserAudio {
  secure: boolean;
  microphone: () => Promise<MediaStream>;
  context: () => AudioContext;
  processor: (context: AudioContext, maxFrames: number) => AudioWorkletNode;
}
const browser: BrowserAudio = {
  get secure() {
    return globalThis.isSecureContext;
  },
  microphone: () => {
    const devices = navigator.mediaDevices as Partial<MediaDevices> | undefined;
    if (!devices?.getUserMedia)
      return Promise.reject(new Error("This browser does not support microphone capture."));
    return devices.getUserMedia({ audio: true, video: false });
  },
  context: () => new AudioContext(),
  processor: (context, maxFrames) =>
    new AudioWorkletNode(context, "fuse-dictation", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { maxFrames },
    }),
};

/** Every exit path releases tracks/context, including a permission grant after cancellation. */
export async function browserRecording(
  signal?: AbortSignal,
  env: BrowserAudio = browser,
): Promise<Recording> {
  if (!env.secure)
    throw new Error("Microphone capture needs HTTPS. Open FUSE through its secure HULK address.");
  if (signal?.aborted) throw aborted();
  const stream = await env.microphone();
  let context: AudioContext | null = null;
  let processor: AudioWorkletNode | null = null;
  let input: MediaStreamAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const state: {
    phase: CaptureStatus["phase"];
    consumed: boolean;
    startupTimer: ReturnType<typeof setTimeout> | null;
  } = { phase: "recording", consumed: false, startupTimer: null };
  let error: string | null = null;
  let frames = 0;
  let rate = 0;
  const chunks: Float32Array[] = [];
  const wipe = () => {
    for (const c of chunks) c.fill(0);
    chunks.length = 0;
  };
  const detach = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    processor?.port.close();
    processor?.disconnect();
    input?.disconnect();
    gain?.disconnect();
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  };
  const cancel = () => {
    state.consumed = true;
    state.phase = "error";
    error = "Recording cancelled.";
    detach();
    wipe();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const finish = () => {
    if (state.consumed || state.phase !== "recording") return;
    state.phase = "ready";
    detach();
  };
  // Both values can change while permission/module/resume promises are pending.
  const assertActive = () => {
    if (signal?.aborted || state.consumed) throw aborted();
  };
  try {
    await Promise.race([
      (async () => {
        assertActive();
        context = env.context();
        rate = context.sampleRate;
        if (!Number.isInteger(rate) || rate < 8000 || rate > 96000)
          throw new Error("This microphone's sample rate is unsupported.");
        await context.audioWorklet.addModule(
          new URL("dictation-worklet.js", document.baseURI).href,
        );
        assertActive();
        const maxFrames = Math.min(
          Math.floor((rate * speechPrice.max_duration_ms) / 1000),
          Math.floor((speechPrice.max_bytes - 44) / 2),
        );
        processor = env.processor(context, maxFrames);
        processor.port.onmessage = (event: MessageEvent<unknown>) => {
          if (!event.data || typeof event.data !== "object") return;
          const data = event.data as { type?: unknown; samples?: unknown };
          if (state.consumed || state.phase !== "recording") {
            if (data.samples instanceof Float32Array) data.samples.fill(0);
            return;
          }
          if (data.type === "limit") {
            finish();
            return;
          }
          if (data.type !== "samples" || !(data.samples instanceof Float32Array)) return;
          const count = Math.min(data.samples.length, maxFrames - frames);
          if (count === 0) {
            data.samples.fill(0);
            return;
          }
          chunks.push(data.samples.slice(0, count));
          frames += count;
          data.samples.fill(0);
          if (frames >= maxFrames) finish();
        };
        processor.onprocessorerror = () => {
          cancel();
          error = "Audio capture stopped unexpectedly.";
        };
        input = context.createMediaStreamSource(stream);
        gain = context.createGain();
        gain.gain.value = 0;
        input.connect(processor);
        processor.connect(gain);
        gain.connect(context.destination);
        for (const track of stream.getTracks())
          track.onended = () => {
            cancel();
            error = "Microphone disconnected or permission was revoked.";
          };
        await context.resume();
        assertActive();
        if (state.phase === "recording") timer = setTimeout(finish, speechPrice.max_duration_ms);
      })(),
      new Promise<never>((_resolve, reject) => {
        state.startupTimer = setTimeout(() => {
          cancel();
          reject(new Error("Microphone startup timed out. Try recording again."));
        }, 8000);
      }),
    ]);
  } catch (cause) {
    cancel();
    signal?.removeEventListener("abort", cancel);
    throw cause;
  } finally {
    if (state.startupTimer !== null) clearTimeout(state.startupTimer);
  }
  return {
    status: () =>
      Promise.resolve({
        phase: state.phase,
        durationMs: Math.floor((frames * 1000) / rate),
        bytes: frames * 2 + 44,
        error,
      }),
    stop: () => {
      try {
        if (state.consumed) throw new Error(error ?? "Recording is no longer open.");
        finish();
        state.consumed = true;
        return Promise.resolve(encodeRecording(chunks, rate));
      } catch (cause) {
        return Promise.reject(cause instanceof Error ? cause : new Error("Recording failed."));
      } finally {
        detach();
        wipe();
        signal?.removeEventListener("abort", cancel);
      }
    },
    cancel: () => {
      cancel();
      signal?.removeEventListener("abort", cancel);
      return Promise.resolve();
    },
  };
}

export async function nativeRecording(consent: boolean, signal?: AbortSignal): Promise<Recording> {
  if (signal?.aborted) throw aborted();
  const { id } = await invoke<CaptureStatus & { id: string }>("audio_start", { consent });
  const cancel = () => {
    void invoke("audio_cancel", { id }).catch(() => undefined);
  };
  if (signal?.aborted) {
    await invoke("audio_cancel", { id });
    throw aborted();
  }
  signal?.addEventListener("abort", cancel, { once: true });
  const remove = () => {
    signal?.removeEventListener("abort", cancel);
  };
  return {
    status: () => invoke<CaptureStatus>("audio_status", { id }),
    stop: async () => {
      try {
        const bytes = new Uint8Array(await invoke<ArrayBuffer>("audio_stop", { id }));
        if (signal?.aborted) {
          bytes.fill(0);
          throw aborted();
        }
        return bytes;
      } finally {
        remove();
      }
    },
    cancel: async () => {
      remove();
      await invoke("audio_cancel", { id });
    },
  };
}

export const startRecording = (consent: boolean, signal?: AbortSignal): Promise<Recording> => {
  if (!consent) return Promise.reject(new Error("Agree to audio transfer before recording."));
  return isDesktop() ? nativeRecording(consent, signal) : browserRecording(signal);
};
