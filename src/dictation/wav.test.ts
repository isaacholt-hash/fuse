import { encodeRecording, recordingDuration } from "./wav";
import { speechPrice } from "@/cost/duration";

test("canonical PCM16 carries actual duration, clamps samples and rejects forged metadata", () => {
  const samples = new Float32Array(8000);
  samples.set([-2, 2, NaN, Infinity, 0.5]);
  const wav = encodeRecording([samples], 8000);
  expect(recordingDuration(wav)).toBe(1000);
  const pcm = new DataView(wav.buffer);
  expect([0, 1, 2, 3, 4].map((i) => pcm.getInt16(44 + i * 2, true))).toEqual([
    -32767, 32767, 0, 0, 16384,
  ]);
  wav[24] = 0;
  expect(() => recordingDuration(wav)).toThrow(/Invalid/);
});

test("duration and byte limits are independent and empty recordings cannot be uploaded", () => {
  expect(() => encodeRecording([], 8000)).toThrow(/empty/);
  expect(() => encodeRecording([new Float32Array(8000 * 120 + 1)], 8000)).toThrow(/limits/);
  expect(() => encodeRecording([new Float32Array(8)], 0)).toThrow(/unsupported/);
  expect(() => recordingDuration(new Uint8Array(speechPrice.max_bytes + 1))).toThrow(/20 MiB/);
  expect(recordingDuration(encodeRecording([new Float32Array(8000 * 120)], 8000))).toBe(120000);
});
