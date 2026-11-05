import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Tooltip } from "radix-ui";
import { Composer } from "@/ui/Conversation";
import { PanelActivity } from "@/ui/panelActivity";
import type { DictationConfig } from "./useDictation";
import type { Transcription } from "./api";
import { encodeRecording } from "./wav";

afterEach(cleanup);
const model = {
  id: "fixture",
  provider: "anthropic" as const,
  providerName: "Anthropic",
  name: "Fixture",
  context: "200K",
  inputPrice: 1,
  outputPrice: 1,
};
const receipt: Transcription = {
  requestId: "speech-fixture",
  text: "Dictated text.",
  durationMs: 1000,
  billingState: "reported",
  costMicroUsd: 75,
  boundMicroUsd: 75,
};
function fixture(overrides: Partial<DictationConfig> = {}) {
  const recording = {
    status: vi.fn().mockResolvedValue({ phase: "recording", durationMs: 1000, bytes: 16044 }),
    stop: vi
      .fn()
      .mockImplementation(() => Promise.resolve(encodeRecording([new Float32Array(8000)], 8000))),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const api = {
    start: vi.fn().mockResolvedValue(recording),
    transcribe: vi.fn().mockResolvedValue(receipt),
  };
  const config: DictationConfig = {
    api,
    scope: "project:fixture",
    lifecycleKey: "chat:new:fixture",
    consent: true,
    reason: null,
    web: false,
    onConsent: vi.fn().mockResolvedValue(undefined),
    onSettled: vi.fn(),
    ...overrides,
  };
  const send = vi.fn();
  const view = (value = config, active = true) => (
    <Tooltip.Provider>
      <PanelActivity value={active}>
        <Composer
          dictation={value}
          model={model}
          models={[model]}
          streaming={false}
          missingKey={null}
          pickerOpen={false}
          onPickerOpen={() => undefined}
          onSelectModel={() => undefined}
          onSend={send}
          onStop={() => undefined}
          onSettings={() => undefined}
        />
      </PanelActivity>
    </Tooltip.Provider>
  );
  return { recording, api, config, send, view };
}
async function record() {
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
  await screen.findByRole("button", { name: "Stop recording and transcribe" });
}

test("transcription appends once to the current edited draft, keeps scope and never sends", async () => {
  const f = fixture();
  render(f.view());
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Original  " } });
  let resolve!: (result: Transcription) => void;
  f.api.transcribe.mockImplementation(
    () =>
      new Promise<Transcription>((r) => {
        resolve = r;
      }),
  );
  await record();
  expect(screen.getByRole("button", { name: "Send message (Enter)" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording and transcribe" }));
  await waitFor(() => {
    expect(f.api.transcribe).toHaveBeenCalledOnce();
  });
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Edited while uploading  " },
  });
  await act(async () => {
    resolve(receipt);
    await Promise.resolve();
  });
  expect(screen.getByLabelText("Message")).toHaveValue(
    "Edited while uploading  \n\nDictated text.",
  );
  expect(f.api.transcribe.mock.calls[0]?.slice(1, 3)).toEqual(["project:fixture", true]);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.config.onSettled).toHaveBeenCalledOnce();
  // Duplicate request identity cannot insert the same transcript twice.
  f.api.transcribe.mockResolvedValue(receipt);
  await record();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording and transcribe" }));
  await waitFor(() => {
    expect(f.api.transcribe).toHaveBeenCalledTimes(2);
  });
  expect(screen.getByLabelText("Message")).toHaveValue(
    "Edited while uploading  \n\nDictated text.",
  );
});

test("consent is explicit and agreeing does not open the microphone", async () => {
  const f = fixture({ consent: false, web: true });
  render(f.view());
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("trusted HULK");
  expect(f.api.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Agree to audio transfer" }));
  await waitFor(() => {
    expect(f.config.onConsent).toHaveBeenCalledWith(true);
  });
  expect(f.api.start).not.toHaveBeenCalled();
});

test.each(["Local-only project.", "Connect OpenAI in Settings to use dictation."])(
  "policy or connection refusal blocks recording: %s",
  (reason) => {
    const f = fixture({ reason });
    render(f.view());
    expect(screen.getByRole("button", { name: "Dictate" })).toBeDisabled();
    expect(f.api.start).not.toHaveBeenCalled();
  },
);

test.each(["panel", "scope", "consent", "unmount", "pagehide"])(
  "leaving or changing permission cancels audio: %s",
  async (change) => {
    const f = fixture();
    const ui = render(f.view());
    await record();
    if (change === "panel") ui.rerender(f.view(f.config, false));
    if (change === "scope")
      ui.rerender(f.view({ ...f.config, lifecycleKey: "code:new:other", scope: "project:other" }));
    if (change === "consent") ui.rerender(f.view({ ...f.config, consent: false }));
    if (change === "unmount") ui.unmount();
    if (change === "pagehide") fireEvent(window, new Event("pagehide"));
    await waitFor(() => {
      expect(f.recording.cancel).toHaveBeenCalled();
    });
    expect((f.api.start.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    expect(f.api.transcribe).not.toHaveBeenCalled();
  },
);

test("cancelled upload cannot insert a late transcript; incurred-cost refresh still runs", async () => {
  const f = fixture();
  render(f.view());
  let resolve!: (result: Transcription) => void;
  f.api.transcribe.mockImplementation(
    () =>
      new Promise<Transcription>((r) => {
        resolve = r;
      }),
  );
  await record();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording and transcribe" }));
  await waitFor(() => {
    expect(f.api.transcribe).toHaveBeenCalledOnce();
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
  await act(async () => {
    resolve(receipt);
    await Promise.resolve();
  });
  expect(screen.getByLabelText("Message")).toHaveValue("");
  expect(f.config.onSettled).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});

test("permission denial is actionable, and unknown billing is visible without an automatic retry", async () => {
  const f = fixture();
  f.api.start.mockRejectedValueOnce(new Error("Microphone permission denied."));
  render(f.view());
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
  await screen.findAllByText("Microphone permission denied.");
  f.api.transcribe.mockResolvedValue({ ...receipt, billingState: "unknown", costMicroUsd: null });
  await record();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording and transcribe" }));
  await screen.findAllByText(/Billing unresolved/);
  expect(f.api.transcribe).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});

test("the native/browser duration limit transcribes once without sending", async () => {
  const f = fixture();
  f.recording.status.mockResolvedValue({ phase: "ready", durationMs: 120000, bytes: 1920044 });
  render(f.view());
  await record();
  await screen.findByDisplayValue("Dictated text.");
  expect(f.recording.stop).toHaveBeenCalledOnce();
  expect(f.api.transcribe).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});

test("hold-to-talk release during microphone startup finishes once, without a duplicate click", async () => {
  const f = fixture();
  let release!: (recording: typeof f.recording) => void;
  f.api.start.mockImplementation(
    () =>
      new Promise<typeof f.recording>((resolve) => {
        release = resolve;
      }),
  );
  render(f.view());
  const mic = screen.getByRole("button", { name: "Dictate" });
  mic.setPointerCapture = vi.fn();
  mic.releasePointerCapture = vi.fn();
  mic.hasPointerCapture = () => true;
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  fireEvent(mic, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  clock.mockReturnValue(600);
  fireEvent(mic, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  fireEvent.click(mic, { detail: 1 });
  await act(async () => {
    release(f.recording);
    await Promise.resolve();
  });
  await screen.findByDisplayValue("Dictated text.");
  expect(f.api.start).toHaveBeenCalledOnce();
  expect(f.api.transcribe).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
  clock.mockRestore();
});

test("a short pointer click starts recording and the next click stops it", async () => {
  const f = fixture();
  render(f.view());
  const mic = screen.getByRole("button", { name: "Dictate" });
  mic.setPointerCapture = vi.fn();
  mic.releasePointerCapture = vi.fn();
  mic.hasPointerCapture = () => true;
  fireEvent(mic, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  fireEvent(mic, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  fireEvent.click(mic, { detail: 1 });
  await screen.findByRole("button", { name: "Stop recording and transcribe" });
  expect(f.api.transcribe).not.toHaveBeenCalled();
  fireEvent.click(mic, { detail: 1 });
  await screen.findByDisplayValue("Dictated text.");
  expect(f.api.transcribe).toHaveBeenCalledOnce();
});

test("a cancelled pointer gesture does not swallow the next keyboard-started stop", async () => {
  const f = fixture();
  render(f.view());
  const mic = screen.getByRole("button", { name: "Dictate" });
  mic.setPointerCapture = vi.fn();
  fireEvent(mic, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  fireEvent(mic, new MouseEvent("pointercancel", { bubbles: true, button: 0 }));
  await record(); // Keyboard-style click, detail=0.
  fireEvent.click(screen.getByRole("button", { name: "Stop recording and transcribe" }), {
    detail: 1,
  });
  await screen.findByDisplayValue("Dictated text.");
  expect(f.api.transcribe).toHaveBeenCalledOnce();
});
