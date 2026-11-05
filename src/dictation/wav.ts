import { speechPrice } from "@/cost/duration";

/** Canonical mono PCM16 only. The native transport repeats these checks before dispatch. */
export function recordingDuration(bytes: Uint8Array): number {
  if (bytes.length < 46 || bytes.length > speechPrice.max_bytes)
    throw new Error("A recording needs audio and must fit within 20 MiB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
    return true;
  };
  const rate = view.getUint32(24, true);
  if (
    !tag(0, "RIFF") ||
    !tag(8, "WAVEfmt ") ||
    !tag(36, "data") ||
    view.getUint32(4, true) !== bytes.length - 8 ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    rate < 8000 ||
    rate > 96000 ||
    view.getUint32(28, true) !== rate * 2 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(40, true) !== bytes.length - 44 ||
    (bytes.length - 44) % 2 !== 0
  )
    throw new Error("Invalid recording. Record mono PCM16 WAV audio again.");
  const duration = Math.ceil((((bytes.length - 44) / 2) * 1000) / rate);
  if (duration > speechPrice.max_duration_ms)
    throw new Error("Recordings are limited to two minutes.");
  return duration;
}

export function encodeRecording(chunks: readonly Float32Array[], rate: number): Uint8Array {
  const frames = chunks.reduce((count, chunk) => count + chunk.length, 0);
  if (
    !Number.isInteger(rate) ||
    rate < 8000 ||
    rate > 96000 ||
    frames < 1 ||
    frames > Math.floor((rate * speechPrice.max_duration_ms) / 1000) ||
    frames * 2 + 44 > speechPrice.max_bytes
  )
    throw new Error("Recording is empty, unsupported or exceeds its limits.");
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, frames * 2, true);
  let at = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      view.setInt16(
        at,
        Math.round((Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0) * 32767),
        true,
      );
      at += 2;
    }
  return bytes;
}
