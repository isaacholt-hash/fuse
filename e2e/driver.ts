// M8 step 14: drives the test build over WebView2's DevTools port (the test build opens it,
// src-tauri/tauri.e2e.conf.json). Not msedgedriver: from WebView2 133 on, it crashes the WebView
// it launches (MicrosoftEdge/WebView2Feedback#5415). Clicks and keys are real input events.
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 9222;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keys by name, as CDP's Input.dispatchKeyEvent wants them. */
const KEYS: Partial<Record<string, { key: string; code: string; vk: number; text?: string }>> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  k: { key: "k", code: "KeyK", vk: 75 },
  n: { key: "n", code: "KeyN", vk: 78 },
  ",": { key: ",", code: "Comma", vk: 188 },
};

export class Session {
  private next = 0;
  private readonly waiting = new Map<
    number,
    { ok: (v: unknown) => void; fail: (e: Error) => void }
  >();

  private constructor(
    private readonly app: ChildProcess,
    private readonly socket: WebSocket,
  ) {
    socket.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) return;
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) w?.fail(new Error(msg.error.message));
      else w?.ok(msg.result);
    });
  }

  /** Starts the app and attaches to its window's page. */
  static async start(application: string): Promise<Session> {
    const app = spawn(application, [], { stdio: "inherit" });
    const until = Date.now() + 60_000;
    let url: string | undefined;
    while (!url) {
      if (app.exitCode !== null) throw new Error(`The app exited (${String(app.exitCode)})`);
      if (Date.now() > until) throw new Error(`No DevTools port ${String(PORT)} after 60 s`);
      const pages = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)
        .then((r) => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>)
        .catch(() => []);
      url = pages.find((p) => p.type === "page")?.webSocketDebuggerUrl;
      if (!url) await sleep(500);
    }
    const socket = new WebSocket(url);
    await new Promise((ok, fail) => {
      socket.addEventListener("open", ok);
      socket.addEventListener("error", () => {
        fail(new Error("Couldn't open the DevTools socket"));
      });
    });
    return new Session(app, socket);
  }

  private send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.next;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((ok, fail) => {
      this.waiting.set(id, {
        ok: (v) => {
          ok(v as T);
        },
        fail,
      });
    });
  }

  /** Runs a function body in the page and returns its result. */
  async run<T>(body: string): Promise<T> {
    const r = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    }>("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value as T;
  }

  /** The XPath's first match: its centre on screen and its text, or null. */
  private probe(xpath: string) {
    return this.run<{ x: number; y: number; text: string } | null>(`
      const el = document.evaluate(${JSON.stringify(xpath)}, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!(el instanceof HTMLElement)) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.innerText };`);
  }

  /** Waits up to `ms` for the XPath to match something visible. */
  async find(xpath: string, ms = 15_000): Promise<{ x: number; y: number; text: string }> {
    const until = Date.now() + ms;
    for (;;) {
      const hit = await this.probe(xpath);
      if (hit) return hit;
      if (Date.now() > until) throw new Error(`Nothing matched ${xpath} within ${String(ms)} ms`);
      await sleep(250);
    }
  }

  /** Waits until nothing visible matches the XPath. */
  async gone(xpath: string, ms = 15_000): Promise<void> {
    const until = Date.now() + ms;
    while (await this.probe(xpath)) {
      if (Date.now() > until) throw new Error(`${xpath} still there after ${String(ms)} ms`);
      await sleep(250);
    }
  }

  async click(xpath: string, ms?: number): Promise<void> {
    const { x, y } = await this.find(xpath, ms);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }

  /** Clicks the field, then types into it. */
  async type(xpath: string, text: string): Promise<void> {
    await this.click(xpath);
    await this.send("Input.insertText", { text });
  }

  async text(xpath: string, ms?: number): Promise<string> {
    return (await this.find(xpath, ms)).text;
  }

  /** Waits until the page's visible text contains `want`. */
  async sees(want: string, ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    while (!(await this.run<string>("return document.body.innerText;")).includes(want)) {
      if (Date.now() > until) throw new Error(`The page never showed “${want}”`);
      await sleep(250);
    }
  }

  /** A key, with Ctrl held when `ctrl`. */
  async press(name: string, ctrl = false): Promise<void> {
    const k = KEYS[name];
    if (!k) throw new Error(`No key ${name}`);
    const base = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      modifiers: ctrl ? 2 : 0,
    };
    if (ctrl) {
      await this.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Control",
        code: "ControlLeft",
        windowsVirtualKeyCode: 17,
        modifiers: 2,
      });
    }
    await this.send("Input.dispatchKeyEvent", {
      ...base,
      type: k.text && !ctrl ? "keyDown" : "rawKeyDown",
      ...(k.text && !ctrl ? { text: k.text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    if (ctrl) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Control",
        code: "ControlLeft",
        windowsVirtualKeyCode: 17,
      });
    }
  }

  chord(name: string): Promise<void> {
    return this.press(name, true);
  }

  /** Lays the page out at this size, as a window of it would. */
  async resize(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    });
  }

  async unsize(): Promise<void> {
    await this.send("Emulation.clearDeviceMetricsOverride");
  }

  async screenshot(path: string): Promise<void> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    writeFileSync(path, Buffer.from(data, "base64"));
  }

  quit(): void {
    this.socket.close();
    this.app.kill();
  }
}

/** An XPath for a button by its accessible label or its text. */
export const button = (name: string) =>
  `//button[@aria-label=${lit(name)} or normalize-space()=${lit(name)}]`;
export const byLabel = (name: string) => `//*[@aria-label=${lit(name)}]`;

/** An XPath string literal, quoting either way. */
function lit(s: string): string {
  return s.includes('"') ? `'${s}'` : `"${s}"`;
}
