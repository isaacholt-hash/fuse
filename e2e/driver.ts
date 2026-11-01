// M8 step 14: drives the test build over WebView2's DevTools port (the test build opens it,
// src-tauri/tauri.e2e.conf.json). Not msedgedriver: from WebView2 133 on, it crashes the WebView
// it launches (MicrosoftEdge/WebView2Feedback#5415). Clicks and keys are real input events.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
  // M10 step 16: Ctrl+1 and Ctrl+2 switch between the Chat and Code areas.
  "1": { key: "1", code: "Digit1", vk: 49 },
  "2": { key: "2", code: "Digit2", vk: 50 },
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
        method?: string;
        params?: {
          type?: string;
          args?: { value?: unknown; description?: string }[];
          exceptionDetails?: { text: string; exception?: { description?: string } };
        };
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) {
        this.note(msg.method, msg.params);
        return;
      }
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) w?.fail(new Error(msg.error.message));
      else w?.ok(msg.result);
    });
  }

  /** The page's console and uncaught errors, with times, for e2e/screenshots/console.log. */
  readonly console: string[] = [];
  private readonly started = Date.now();

  private note(
    method: string | undefined,
    params:
      | {
          type?: string;
          args?: { value?: unknown; description?: string }[];
          exceptionDetails?: { text: string; exception?: { description?: string } };
        }
      | undefined,
  ) {
    const at = `${((Date.now() - this.started) / 1000).toFixed(1)}s`;
    if (method === "Runtime.consoleAPICalled") {
      const text = (params?.args ?? [])
        .map((a) =>
          typeof a.value === "string" ? a.value : (a.description ?? JSON.stringify(a.value)),
        )
        .join(" ");
      this.console.push(`${at} ${params?.type ?? "log"}: ${text}`);
    } else if (method === "Runtime.exceptionThrown") {
      const d = params?.exceptionDetails;
      this.console.push(`${at} uncaught: ${d?.exception?.description ?? d?.text ?? "?"}`);
    }
  }

  /**
   * Waits until no page answers on the DevTools port, so a second test file never attaches to the
   * window of an app the first one is still closing.
   */
  static async portFree(ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    for (;;) {
      const open = await fetch(`http://127.0.0.1:${String(PORT)}/json/version`)
        .then(() => true)
        .catch(() => false);
      if (!open) return;
      if (Date.now() > until)
        throw new Error(`Port ${String(PORT)} still open after ${String(ms)} ms`);
      await sleep(500);
    }
  }

  /** Starts the app and attaches to its window's page. */
  static async start(application: string, args: string[] = []): Promise<Session> {
    await Session.portFree();
    const app = spawn(application, args, { stdio: "inherit" });
    const failed: { error?: Error } = {};
    app.on("error", (e) => {
      failed.error = e;
    });
    const until = Date.now() + 60_000;
    let url: string | undefined;
    while (!url) {
      if (failed.error) throw new Error(`Couldn't start ${application}: ${String(failed.error)}`);
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
    const session = new Session(app, socket);
    await session.send("Runtime.enable");
    // A runner's window may sit behind others; keep the page running as if it had focus.
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await session.send("Page.bringToFront");
    return session;
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

  /**
   * The XPath's first match: its centre on screen, its text, and whether it's what a click there
   * would hit (not covered, not mid-animation elsewhere); null when nothing visible matches.
   */
  private probe(xpath: string) {
    return this.run<{ x: number; y: number; text: string; hit: boolean } | null>(`
      const el = document.evaluate(${JSON.stringify(xpath)}, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!(el instanceof HTMLElement)) return null;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { x, y, text: el.innerText, hit: el.contains(document.elementFromPoint(x, y)) };`);
  }

  /** Waits up to `ms` for the XPath to match something visible. */
  async find(
    xpath: string,
    ms = 15_000,
  ): Promise<{ x: number; y: number; text: string; hit: boolean }> {
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

  /** Clicks the match once it's still (popovers animate in) and nothing covers it. */
  async click(xpath: string, ms = 15_000): Promise<void> {
    const until = Date.now() + ms;
    let last = await this.find(xpath, ms);
    for (;;) {
      await sleep(150);
      const now = await this.find(xpath, ms);
      if (now.hit && now.x === last.x && now.y === last.y) break;
      if (Date.now() > until) throw new Error(`${xpath} never held still uncovered`);
      last = now;
    }
    const { x, y } = last;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }

  /** Clicks the field, then types into it. */
  async type(xpath: string, text: string): Promise<void> {
    await this.click(xpath);
    await this.send("Input.insertText", { text });
  }

  /** Picks the option with this text in the select with this label, as a person would. */
  async choose(label: string, option: string): Promise<void> {
    await this.find(byLabel(label));
    const ok = await this.run<boolean>(`
      const s = document.querySelector('select[aria-label=${JSON.stringify(label)}]');
      const o = [...s.options].find((x) => x.text.trim() === ${JSON.stringify(option)});
      if (!o) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, o.value);
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return true;`);
    if (!ok) throw new Error(`No option “${option}” in ${label}`);
  }

  /** Empties a text field the way React sees it. */
  async clear(xpath: string): Promise<void> {
    await this.find(xpath);
    await this.run(`
      const el = document.evaluate(${JSON.stringify(xpath)}, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;`);
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

  /** Opens this address in the page (the web test's browser starts on a blank tab). */
  async navigate(url: string): Promise<void> {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
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

  /** Closes the app and, on Windows, its WebView2 processes, which hold its data folder. */
  quit(): void {
    this.socket.close();
    if (process.platform === "win32" && this.app.pid !== undefined) {
      spawnSync("taskkill", ["/pid", String(this.app.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      this.app.kill();
    }
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
