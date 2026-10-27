import { providerFetch, type StreamMsg } from "./tauriFetch";

/** Fake bridge: records the request and lets the test drive the event stream. */
function fakeBridge() {
  const state: { request?: unknown; emit?: (m: StreamMsg) => void; aborted: number[] } = {
    aborted: [],
  };
  return {
    state,
    bridge: {
      start(request: unknown, onEvent: (m: StreamMsg) => void) {
        state.request = request;
        state.emit = onEvent;
        return Promise.resolve(7);
      },
      abort(id: number) {
        state.aborted.push(id);
        return Promise.resolve();
      },
    },
  };
}

test("sends only path and headers (never a key) and streams the body", async () => {
  const { state, bridge } = fakeBridge();
  const pending = providerFetch("anthropic", bridge)("https://api.anthropic.com/v1/messages?x=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  await Promise.resolve();
  expect(state.request).toEqual({
    provider: "anthropic",
    method: "POST",
    path: "/v1/messages?x=1",
    headers: [["content-type", "application/json"]],
    body: "{}",
  });
  state.emit?.({ kind: "head", status: 200, headers: [["request-id", "req_1"]] });
  const res = await pending;
  expect(res.status).toBe(200);
  expect(res.headers.get("request-id")).toBe("req_1");
  state.emit?.({ kind: "chunk", data: "data: a\n\n" });
  state.emit?.({ kind: "chunk", data: "data: é\n\n" });
  state.emit?.({ kind: "end" });
  expect(await res.text()).toBe("data: a\n\ndata: é\n\n");
});

test("an error before the head rejects like fetch does", async () => {
  const { state, bridge } = fakeBridge();
  const pending = providerFetch("openai", bridge)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {},
  });
  await Promise.resolve();
  state.emit?.({ kind: "error", message: "Network error: refused" });
  await expect(pending).rejects.toThrow(/refused/);
});

test("aborting cancels the Rust request", async () => {
  const { state, bridge } = fakeBridge();
  const controller = new AbortController();
  const pending = providerFetch("openai", bridge)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {},
    signal: controller.signal,
  });
  await Promise.resolve();
  await Promise.resolve();
  state.emit?.({ kind: "head", status: 200, headers: [] });
  const res = await pending;
  controller.abort();
  expect(state.aborted).toEqual([7]);
  await expect(res.text()).rejects.toThrow(/Aborted/);
});

test("a missing key becomes a non-retryable 401 the adapters understand", async () => {
  const bridge = {
    start: () => Promise.reject(new Error("no_key: No API key saved for this provider.")),
    abort: () => Promise.resolve(),
  };
  const res = await providerFetch("anthropic", bridge)("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {},
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("x-fuse-error")).toBe("no_key");
});
