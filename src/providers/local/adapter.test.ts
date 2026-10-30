// @vitest-environment node
import { ProviderError, userMessage } from "../errors";
import { NO_LOCAL_MODEL, unavailableLocalAdapter } from "./adapter";
import { scriptedLocal } from "./scripted";

test("with no model installed, a local request fails with the reason, before any text", async () => {
  const adapter = unavailableLocalAdapter();
  const events: string[] = [];
  const run = async () => {
    for await (const ev of adapter.streamChat([{ role: "user", content: "hi" }], "qwen3-1.7b", {}))
      events.push(ev.type);
  };
  await expect(run()).rejects.toMatchObject({ kind: "unavailable", message: NO_LOCAL_MODEL });
  expect(events).toEqual([]);
  expect(userMessage(new ProviderError("unavailable", NO_LOCAL_MODEL), "Local model")).toBe(
    NO_LOCAL_MODEL,
  );
});

test("the scripted local model answers in order, records each call, and can fail", async () => {
  const local = scriptedLocal(["first", new ProviderError("stream", "malformed")]);
  const collect = async () => {
    let text = "";
    for await (const ev of local.adapter.streamChat([{ role: "user", content: "q" }], "m", {
      system: "s",
    })) {
      if (ev.type === "text") text += ev.text;
    }
    return text;
  };
  expect(await collect()).toBe("first");
  await expect(collect()).rejects.toMatchObject({ kind: "stream" });
  expect(await collect()).toBe("ok");
  expect(local.calls).toHaveLength(3);
  expect(local.calls[0]?.system).toBe("s");
});
