// M8 step 14: a small W3C WebDriver client for tauri-driver, which forwards to Edge's
// msedgedriver on Windows. Plain fetch, so the click-through tests add no dependencies.
import { writeFileSync } from "node:fs";

const ELEMENT = "element-6066-11e4-a52f-4a6976d4ce5e";
export const KEY = { enter: "", escape: "", control: "" } as const;

type Element = { [ELEMENT]: string };

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await r.json()) as { value: T };
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value).slice(0, 500)}`);
  return json.value;
}

export class Session {
  private constructor(
    private readonly base: string,
    private readonly id: string,
  ) {}

  static async start(base: string, application: string): Promise<Session> {
    const v = await call<{ sessionId: string }>(base, "POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application } } },
    });
    return new Session(base, v.sessionId);
  }

  private do<T>(method: string, path: string, body?: unknown) {
    return call<T>(this.base, method, `/session/${this.id}${path}`, body);
  }

  /** Runs a script in the page and returns its result. */
  run<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.do<T>("POST", "/execute/sync", { script, args });
  }

  /** The first element the XPath matches, waiting for it up to `ms`. */
  async find(xpath: string, ms = 15_000): Promise<Element> {
    const until = Date.now() + ms;
    for (;;) {
      const found = await this.do<Element[]>("POST", "/elements", { using: "xpath", value: xpath });
      if (found[0]) return found[0];
      if (Date.now() > until) throw new Error(`Nothing matched ${xpath} within ${String(ms)} ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Waits until nothing matches the XPath. */
  async gone(xpath: string, ms = 15_000): Promise<void> {
    const until = Date.now() + ms;
    while (
      (await this.do<Element[]>("POST", "/elements", { using: "xpath", value: xpath })).length
    ) {
      if (Date.now() > until) throw new Error(`${xpath} still there after ${String(ms)} ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async click(xpath: string, ms?: number): Promise<void> {
    const el = await this.find(xpath, ms);
    await this.do("POST", `/element/${el[ELEMENT]}/click`, {});
  }

  async type(xpath: string, text: string): Promise<void> {
    const el = await this.find(xpath);
    await this.do("POST", `/element/${el[ELEMENT]}/value`, { text });
  }

  async text(xpath: string, ms?: number): Promise<string> {
    const el = await this.find(xpath, ms);
    return this.do<string>("GET", `/element/${el[ELEMENT]}/text`);
  }

  /** Waits until the page's visible text contains `want`. */
  async sees(want: string, ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    while (!(await this.run<string>("return document.body.innerText;")).includes(want)) {
      if (Date.now() > until) throw new Error(`The page never showed “${want}”`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** A key with Ctrl held, e.g. chord("k") for Ctrl+K. */
  async chord(key: string): Promise<void> {
    await this.do("POST", "/actions", {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: KEY.control },
            { type: "keyDown", value: key },
            { type: "keyUp", value: key },
            { type: "keyUp", value: KEY.control },
          ],
        },
      ],
    });
  }

  async press(key: string): Promise<void> {
    await this.do("POST", "/actions", {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: key },
            { type: "keyUp", value: key },
          ],
        },
      ],
    });
  }

  async screenshot(path: string): Promise<void> {
    writeFileSync(path, Buffer.from(await this.do<string>("GET", "/screenshot"), "base64"));
  }

  async quit(): Promise<void> {
    await this.do("DELETE", "");
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
