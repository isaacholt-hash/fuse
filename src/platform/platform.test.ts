import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Channel } from "./channel";
import { configureHttp, httpConvertFileSrc, httpInvoke } from "./http";

interface Sent {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: (s: Sent) => Response) {
  const sent: Sent[] = [];
  const f = ((url: string, init: RequestInit) => {
    const s = { url, init };
    sent.push(s);
    return Promise.resolve(reply(s));
  }) as unknown as typeof fetch;
  return { f, sent };
}

/** A WebSocket the test drives: `open()` connects it, `push()` is a message from the server. */
class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) } as MessageEvent);
  }
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  FakeSocket.last = null;
});

describe("the HTTP platform", () => {
  it("posts a command's arguments and returns its result", async () => {
    const { f, sent } = fakeFetch(() => json({ ok: 1 }));
    configureHttp({ base: "https://hulk.test", fetch: f });
    await expect(httpInvoke("key_status", { provider: "openai" })).resolves.toEqual({ ok: 1 });
    expect(sent[0]?.url).toBe("https://hulk.test/api/invoke/key_status");
    expect(sent[0]?.init.method).toBe("POST");
    expect(JSON.parse(sent[0]?.init.body as string)).toEqual({ provider: "openai" });
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers["x-fuse-client"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.authorization).toBeUndefined();
  });

  it("rejects with the command's own error value, as Tauri does", async () => {
    const { f } = fakeFetch(() => json({ error: "no_key: Add a key first." }, 400));
    configureHttp({ base: "", fetch: f });
    await expect(httpInvoke("provider_fetch")).rejects.toBe("no_key: Add a key first.");
  });

  it("says so when the server's reply isn't an error value", async () => {
    const { f } = fakeFetch(() => new Response("", { status: 502 }));
    configureHttp({ base: "", fetch: f });
    await expect(httpInvoke("db_open")).rejects.toBe("FUSE on the server answered 502.");
  });

  it("streams a channel's messages over the socket, in order, until it's closed", async () => {
    const { f, sent } = fakeFetch(() => json(7));
    configureHttp({
      base: "http://127.0.0.1:4100",
      fetch: f,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    const ch = new Channel<string>();
    const got: string[] = [];
    ch.onmessage = (m) => got.push(m);
    await expect(httpInvoke<number>("repo_exec", { command: "ls", onEvent: ch })).resolves.toBe(7);

    const ws = FakeSocket.last;
    expect(ws?.url).toMatch(/^ws:\/\/127\.0\.0\.1:4100\/api\/events\?client=[0-9a-f-]{36}$/);
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(ws?.url).toContain(headers["x-fuse-client"]);
    expect(JSON.parse(sent[0]?.init.body as string)).toEqual({
      command: "ls",
      onEvent: { __fuse_channel: ch.id },
    });

    ws?.push({ channel: ch.id, message: "a" });
    ws?.push({ channel: "someone-else", message: "x" });
    ws?.push({ channel: ch.id, message: "b" });
    ws?.push({ channel: ch.id, close: true });
    ws?.push({ channel: ch.id, message: "late" });
    expect(got).toEqual(["a", "b"]);
  });

  it("sends a device token as a header and as the socket's first message", async () => {
    const { f, sent } = fakeFetch(() => json(null));
    configureHttp({
      base: "https://hulk.test",
      token: "device-token",
      fetch: f,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    await httpInvoke("python_install", { onEvent: new Channel() });
    expect((sent[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer device-token",
    );
    expect(FakeSocket.last?.url.startsWith("wss://hulk.test/")).toBe(true);
    expect(FakeSocket.last?.sent).toEqual([JSON.stringify({ auth: "device-token" })]);
    configureHttp({ token: undefined });
  });

  it("sends bytes as the body with their headers, and returns bytes as an ArrayBuffer", async () => {
    const { f, sent } = fakeFetch(
      () =>
        new Response(new Uint8Array([9, 8]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    configureHttp({ base: "", fetch: f });
    const got = await httpInvoke<ArrayBuffer>("file_put", new Uint8Array([1, 2]), {
      headers: { "x-file-name": "a.txt" },
    });
    expect([...new Uint8Array(got)]).toEqual([9, 8]);
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["x-file-name"]).toBe("a.txt");
    expect(sent[0]?.init.body).toEqual(new Uint8Array([1, 2]));
  });

  it("serves previews from the server", () => {
    configureHttp({ base: "https://hulk.test" });
    expect(httpConvertFileSrc("ab/c.html", "preview")).toBe(
      "https://hulk.test/api/asset/preview/ab%2Fc.html",
    );
  });
});

describe("the platform seam", () => {
  it("is the only place that imports Tauri", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (p !== join("src", "platform")) walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, "utf8").includes("@tauri-apps/")) {
          offenders.push(p);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});
