import { transcribe, type TranscriptionBridge, type Transcription } from "./api";
import { encodeRecording } from "./wav";

const result: Transcription = {
  requestId: "receipt",
  text: "Editable words",
  durationMs: 1000,
  billingState: "reported",
  costMicroUsd: 75,
  boundMicroUsd: 75,
};
const audio = () => encodeRecording([new Float32Array(8000)], 8000);
function bridge() {
  return {
    prepare: vi
      .fn<TranscriptionBridge["prepare"]>()
      .mockResolvedValue({ id: "receipt", boundMicroUsd: 75 }),
    upload: vi.fn<TranscriptionBridge["upload"]>().mockResolvedValue(result),
    cancel: vi.fn<TranscriptionBridge["cancel"]>().mockResolvedValue(undefined),
  };
}

test("a successful transcript is returned once and raw bytes are wiped", async () => {
  const api = bridge();
  const bytes = audio();
  expect(await transcribe(bytes, "project:fixture", true, undefined, api)).toEqual(result);
  expect(api.prepare).toHaveBeenCalledWith("project:fixture", 1000, true);
  expect(api.upload).toHaveBeenCalledTimes(1);
  expect(bytes.every((b) => b === 0)).toBe(true);
});

test("consent and malformed audio refuse before preparing a paid operation", async () => {
  const api = bridge();
  const bytes = audio();
  await expect(transcribe(bytes, "global", false, undefined, api)).rejects.toThrow(/Agree/);
  await expect(transcribe(new Uint8Array([1, 2]), "global", true, undefined, api)).rejects.toThrow(
    /recording/,
  );
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.upload).not.toHaveBeenCalled();
  expect(bytes.every((b) => b === 0)).toBe(true);
});

test("cancellation during preparation releases the quote without uploading", async () => {
  const api = bridge();
  const abort = new AbortController();
  let ready!: (value: { id: string; boundMicroUsd: number }) => void;
  api.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  const pending = transcribe(audio(), "global", true, abort.signal, api);
  abort.abort();
  ready({ id: "receipt", boundMicroUsd: 75 });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(api.cancel).toHaveBeenCalledWith("receipt");
  expect(api.upload).not.toHaveBeenCalled();
});

test("a late billed response is discarded after cancellation without replay", async () => {
  const api = bridge();
  const abort = new AbortController();
  const bytes = audio();
  let finish!: (value: Transcription) => void;
  api.upload.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = transcribe(bytes, "global", true, abort.signal, api);
  await vi.waitFor(() => {
    expect(api.upload).toHaveBeenCalledTimes(1);
  });
  abort.abort();
  expect(bytes.every((b) => b === 0)).toBe(true);
  finish(result);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(api.cancel).toHaveBeenCalledWith("receipt");
  expect(api.upload).toHaveBeenCalledTimes(1);
  expect(bytes.every((b) => b === 0)).toBe(true);
});

test("unknown upload failure cancels safely, retains no audio and never retries", async () => {
  const api = bridge();
  const bytes = audio();
  api.upload.mockRejectedValue(new Error("Connection lost; billing unresolved"));
  await expect(transcribe(bytes, "global", true, undefined, api)).rejects.toThrow(/unresolved/);
  expect(api.upload).toHaveBeenCalledTimes(1);
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(api.cancel).toHaveBeenCalledWith("receipt");
  expect(bytes.every((b) => b === 0)).toBe(true);
});
