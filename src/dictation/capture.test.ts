import { browserRecording, nativeRecording, startRecording, type BrowserAudio } from "./capture";
import { recordingDuration } from "./wav";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/platform/core", () => ({ invoke: native.invoke, isDesktop: () => true }));
beforeEach(() => {
  native.invoke.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

function fixture(module = Promise.resolve()) {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  const port = { close: vi.fn(), onmessage: null as ((e: MessageEvent<unknown>) => void) | null };
  const processor = {
    port,
    connect: vi.fn(),
    disconnect: vi.fn(),
    onprocessorerror: null as (() => void) | null,
  };
  let closed = false;
  const context = {
    sampleRate: 8000,
    get state() {
      return closed ? "closed" : "running";
    },
    audioWorklet: { addModule: vi.fn(() => module) },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => {
      closed = true;
      return Promise.resolve();
    }),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    destination: {},
  };
  // These test nodes implement only the Web Audio lifecycle used by the recorder.
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const env: BrowserAudio = {
    secure: true,
    microphone: vi.fn(() => Promise.resolve(stream)),
    context: vi.fn(() => context as unknown as AudioContext),
    processor: vi.fn(() => processor as unknown as AudioWorkletNode),
  };
  return {
    env,
    context,
    track,
    port,
    processor,
    stream,
    emit: (samples: Float32Array) => {
      port.onmessage?.(new MessageEvent("message", { data: { type: "samples", samples } }));
    },
  };
}

test("browser stop returns editable-draft audio once and releases every microphone resource", async () => {
  const f = fixture();
  const r = await browserRecording(undefined, f.env);
  const samples = new Float32Array(8000).fill(0.25);
  f.emit(samples);
  expect(samples.every((v) => v === 0)).toBe(true);
  expect(await r.status()).toMatchObject({ phase: "recording", durationMs: 1000 });
  expect(recordingDuration(await r.stop())).toBe(1000);
  expect(f.track.stop).toHaveBeenCalled();
  expect(f.context.close).toHaveBeenCalled();
  expect(f.port.close).toHaveBeenCalled();
  await expect(r.stop()).rejects.toThrow(/no longer/);
});

test("recording limits release tracks independently of further UI input", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const r = await browserRecording(undefined, f.env);
  f.emit(new Float32Array(8000));
  await vi.advanceTimersByTimeAsync(120000);
  expect(await r.status()).toMatchObject({ phase: "ready" });
  expect(f.track.stop).toHaveBeenCalled();
  expect(recordingDuration(await r.stop())).toBe(1000);
});

test("abort, disconnect and a late permission grant discard samples and release tracks", async () => {
  const f = fixture();
  const abort = new AbortController();
  const r = await browserRecording(abort.signal, f.env);
  f.emit(new Float32Array(8000));
  abort.abort();
  await expect(r.stop()).rejects.toThrow(/cancelled/);
  expect(f.track.stop).toHaveBeenCalled();
  const late = fixture();
  let grant!: (s: MediaStream) => void;
  late.env.microphone = () =>
    new Promise((resolve) => {
      grant = resolve;
    });
  const cancelled = new AbortController();
  const opening = browserRecording(cancelled.signal, late.env);
  cancelled.abort();
  grant(late.stream);
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  expect(late.track.stop).toHaveBeenCalled();
  expect(late.env.context).not.toHaveBeenCalled();
  const lost = fixture();
  const recording = await browserRecording(undefined, lost.env);
  lost.track.onended?.();
  expect((await recording.status()).error).toMatch(/disconnected/);
  await expect(recording.stop()).rejects.toThrow(/disconnected/);
});

test("permission refusal, insecure origins and stalled initialization cannot leave a mic open", async () => {
  const f = fixture();
  f.env.secure = false;
  await expect(browserRecording(undefined, f.env)).rejects.toThrow(/HTTPS/);
  expect(f.env.microphone).not.toHaveBeenCalled();
  f.env.secure = true;
  f.env.microphone = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
  await expect(browserRecording(undefined, f.env)).rejects.toMatchObject({
    name: "NotAllowedError",
  });
  expect(f.env.context).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const stuck = fixture(
    new Promise(() => {
      /* module load never completes */
    }),
  );
  const failure = browserRecording(undefined, stuck.env).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(8000);
  const error = await failure;
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected the startup failure.");
  expect(error.message).toContain("startup timed out");
  expect(stuck.track.stop).toHaveBeenCalled();
  expect(stuck.context.close).toHaveBeenCalled();
});

test("native cancellation still releases a microphone opened after a cancelled start", async () => {
  let opened!: (v: { id: string }) => void;
  native.invoke.mockImplementation((command: string) =>
    command === "audio_start"
      ? new Promise((resolve) => {
          opened = resolve;
        })
      : Promise.resolve(),
  );
  const abort = new AbortController();
  const pending = nativeRecording(true, abort.signal);
  abort.abort();
  opened({ id: "fixture-recording" });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(native.invoke).toHaveBeenCalledWith("audio_cancel", { id: "fixture-recording" });
  native.invoke.mockReset();
  await expect(startRecording(false)).rejects.toThrow(/Agree/);
  expect(native.invoke).not.toHaveBeenCalled();
});
