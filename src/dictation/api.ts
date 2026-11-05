import { invoke } from "@/platform/core";
import { recordingDuration } from "./wav";

export interface Transcription {
  requestId: string;
  text: string;
  durationMs: number;
  billingState: "reported" | "unknown";
  costMicroUsd: number | null;
  boundMicroUsd: number;
}
export interface TranscriptionBridge {
  prepare(
    scope: string,
    durationMs: number,
    consent: boolean,
  ): Promise<{ id: string; boundMicroUsd: number }>;
  upload(id: string, bytes: Uint8Array): Promise<Transcription>;
  cancel(id: string): Promise<void>;
}
const native: TranscriptionBridge = {
  prepare: (scope, durationMs, consent) =>
    invoke("transcribe_prepare", { scope, durationMs, consent }),
  upload: (id, bytes) => invoke("transcribe_audio", bytes, { headers: { "x-recording-id": id } }),
  cancel: (id) => invoke("transcribe_cancel", { id }),
};

/** No automatic retry and no audio persistence, including when preparation or upload fails. */
export async function transcribe(
  bytes: Uint8Array,
  scope: string,
  consent: boolean,
  signal?: AbortSignal,
  bridge: TranscriptionBridge = native,
): Promise<Transcription> {
  let id: string | null = null;
  const abort = () => {
    bytes.fill(0);
    if (id) void bridge.cancel(id).catch(() => undefined);
  };
  try {
    signal?.addEventListener("abort", abort, { once: true });
    if (!consent) throw new Error("Agree to sending audio to OpenAI before transcribing.");
    if (signal?.aborted) throw new DOMException("Transcription cancelled.", "AbortError");
    const duration = recordingDuration(bytes);
    const ticket = await bridge.prepare(scope, duration, consent);
    id = ticket.id;
    if (signal?.aborted) {
      await bridge.cancel(id);
      throw new DOMException("Transcription cancelled.", "AbortError");
    }
    const result = await bridge.upload(id, bytes);
    if (signal?.aborted) throw new DOMException("Transcription cancelled.", "AbortError");
    return result;
  } catch (error) {
    if (id) await bridge.cancel(id).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    bytes.fill(0);
  }
}
