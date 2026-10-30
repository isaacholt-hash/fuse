// @vitest-environment node
import { ProviderError, userMessage } from "../errors";
import type { StreamEvent } from "../types";
import {
  createLocalAdapter,
  NO_LOCAL_MODEL,
  unavailableLocalAdapter,
  type LocalBackend,
  type LocalMsg,
} from "./adapter";
import { scriptedLocal } from "./scripted";

const collect = async (gen: AsyncGenerator<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

test("with no model installed, a local request fails with the reason, before any text", async () => {
  const run = collect(
    unavailableLocalAdapter().streamChat([{ role: "user", content: "hi" }], "qwen3-1.7b", {}),
  );
  await expect(run).rejects.toMatchObject({ kind: "unavailable", message: NO_LOCAL_MODEL });
  expect(userMessage(new ProviderError("unavailable", NO_LOCAL_MODEL), "Local model")).toBe(
    NO_LOCAL_MODEL,
  );
});

/** A backend that plays back `msgs`, or rejects with `fail`. */
function backend(msgs: LocalMsg[], fail?: string) {
  const calls: Parameters<LocalBackend["generate"]>[0][] = [];
  let cancels = 0;
  const b: LocalBackend = {
    generate: async (req, onMsg) => {
      calls.push(req);
      for (const m of msgs) {
        await Promise.resolve();
        onMsg(m);
      }
      if (fail) throw new Error(fail);
    },
    cancel: () => {
      cancels++;
      return Promise.resolve();
    },
  };
  return { b, calls, cancels: () => cancels };
}

const adapter = (b: LocalBackend) =>
  createLocalAdapter({ backend: b, fileFor: (id) => (id === "qwen3-4b" ? "Qwen3-4B.gguf" : null) });

test("streams the worker's answer as one text, then done with its token counts", async () => {
  const { b, calls } = backend([
    { kind: "text", text: "Convert " },
    { kind: "text", text: "dates" },
    { kind: "done", input_tokens: 55, output_tokens: 2, stop: "stop" },
  ]);
  const events = await collect(
    adapter(b).streamChat([{ role: "user", content: "q" }], "qwen3-4b", {
      system: "Title it.",
      maxOutputTokens: 32,
    }),
  );
  expect(events[0]).toEqual({ type: "text", text: "Convert dates" });
  expect(events[1]).toMatchObject({
    type: "done",
    usage: { inputTokens: 55, outputTokens: 2 },
    stopReason: "stop",
  });
  expect(calls[0]).toMatchObject({
    file: "Qwen3-4B.gguf",
    system: "Title it.",
    maxTokens: 32,
    messages: [{ role: "user", content: "q" }],
  });
});

test("a length stop reads as max_tokens; a stray thinking block is removed", async () => {
  const { b } = backend([
    { kind: "text", text: "<think>hmm</think>\n\nShort title" },
    { kind: "done", input_tokens: 1, output_tokens: 9, stop: "length" },
  ]);
  const events = await collect(adapter(b).streamChat([], "qwen3-4b", {}));
  expect(events[0]).toEqual({ type: "text", text: "Short title" });
  expect(events[1]).toMatchObject({ stopReason: "max_tokens" });
});

test("failures: not installed, worker errors, empty answers", async () => {
  await expect(
    collect(adapter(backend([]).b).streamChat([], "qwen3-9b", {})),
  ).rejects.toMatchObject({
    kind: "unavailable",
  });
  const crashed = backend([{ kind: "text", text: "par" }], "The local model stopped unexpectedly");
  await expect(collect(adapter(crashed.b).streamChat([], "qwen3-4b", {}))).rejects.toMatchObject({
    kind: "unavailable",
    message: "The local model stopped unexpectedly",
  });
  const empty = backend([
    { kind: "text", text: "  " },
    { kind: "done", input_tokens: 1, output_tokens: 1, stop: "stop" },
  ]);
  await expect(collect(adapter(empty.b).streamChat([], "qwen3-4b", {}))).rejects.toMatchObject({
    kind: "stream",
  });
});

test("Stop cancels the worker and ends as aborted", async () => {
  const controller = new AbortController();
  let release: () => void = () => undefined;
  let cancels = 0;
  const b: LocalBackend = {
    generate: async (_req, onMsg) => {
      onMsg({ kind: "text", text: "partial" });
      await new Promise<void>((r) => (release = r));
    },
    cancel: () => {
      cancels++;
      release();
      return Promise.resolve();
    },
  };
  const run = collect(adapter(b).streamChat([], "qwen3-4b", {}, controller.signal));
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await expect(run).rejects.toMatchObject({ kind: "aborted" });
  expect(cancels).toBe(1);
});

test("the scripted local model answers in order, records each call, and can fail", async () => {
  const local = scriptedLocal(["first", new ProviderError("stream", "malformed")]);
  const text = async () =>
    (
      await collect(
        local.adapter.streamChat([{ role: "user", content: "q" }], "m", { system: "s" }),
      )
    )
      .flatMap((e) => (e.type === "text" ? [e.text] : []))
      .join("");
  expect(await text()).toBe("first");
  await expect(text()).rejects.toMatchObject({ kind: "stream" });
  expect(await text()).toBe("ok");
  expect(local.calls).toHaveLength(3);
  expect(local.calls[0]?.system).toBe("s");
});
