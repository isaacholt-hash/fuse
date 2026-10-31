// M8 step 14: FUSE driven like a person would use it, over WebView2's DevTools port, on the test build
// (scripted models, fake keys and update; src/e2e/deps.ts). Run by CI on Windows: see
// e2e/README.md. Each step leaves a screenshot in e2e/screenshots/.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, version } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { button, byLabel, Session } from "./driver";

const APP = process.env.FUSE_E2E_APP ?? "";
const FOLDER = process.env.FUSE_E2E_FOLDER ?? "C:\\fuse-e2e";
const SHOTS = join(import.meta.dirname, "screenshots");
const HELLO = "Hello from the FUSE test script.";
// Windows Server (GitHub's runners) denies the NUL device to sandboxed apps; 10 and 11 don't.
const SERVER = /Server/i.test(version());

let app: Session;
let shot = 0;

async function step(name: string, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    await app.screenshot(join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`));
  }
}

/** The answers on screen, newest last. */
const answers = () =>
  app.run<string[]>(
    "return [...document.querySelectorAll('[data-answer]')].map((e) => e.innerText);",
  );

async function nextAnswer(before: number): Promise<string> {
  const until = Date.now() + 60_000;
  for (;;) {
    const all = await answers();
    const last = all.at(before);
    if (last?.includes("Command result:") || last?.includes(HELLO)) return last;
    if (Date.now() > until) throw new Error(`No new answer; the page has ${String(all.length)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const composer = '//textarea[@aria-label="Message"]';

beforeAll(async () => {
  expect(APP, "set FUSE_E2E_APP to the test build's fuse.exe").not.toBe("");
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  rmSync(FOLDER, { recursive: true, force: true });
  mkdirSync(FOLDER, { recursive: true });
  app = await Session.start(APP);
  await app.find(composer, 60_000);
  // Never drive a real build: only the test build has scripted models.
  expect(await app.run<string>("return document.documentElement.dataset.build ?? '';")).toBe(
    "fuse-e2e-scripted-build",
  );
}, 120_000);

afterAll(() => {
  app.quit();
});

test("send a message and see its cost", async () => {
  await step("message", async () => {
    await app.type(composer, "Say hello");
    await app.press("Enter");
    expect(await nextAnswer(0)).toContain(HELLO);
    await app.find('//*[starts-with(@aria-label, "Cost breakdown for")]');
  });
});

test("switch models", async () => {
  await step("switch-model", async () => {
    await app.chord("k");
    await app.click('//button[.//span[normalize-space()="Claude Opus 5.5"]]');
    await app.type(composer, "Again");
    await app.press("Enter");
    expect(await nextAnswer(1)).toContain(HELLO);
    await app.sees("Switched to Claude Opus 5.5");
  });
});

test("the update bar shows, and Later hides it (M7 F1)", async () => {
  await step("update-bar", async () => {
    expect(await app.text(byLabel("App update"))).toContain("FUSE 9.9.9 is ready");
    await app.click(button("Later"));
    await app.gone(byLabel("App update"));
  });
});

test("open Settings", async () => {
  await step("settings", async () => {
    await app.chord(",");
    await app.find('//h1[normalize-space()="Settings"] | //h2[normalize-space()="Settings"]');
    await app.find('//*[normalize-space()="Run commands in the sandbox"]');
    await app.chord(",");
    await app.find(composer);
  });
});

test("a Work run on a test folder: step 9's checks 2, 3 and 5", async () => {
  const escape = join(homedir(), "Documents", "escape.txt");
  rmSync(escape, { force: true });
  await step("work-setup", async () => {
    await app.chord("n");
    await app.click(button("Add a folder"));
    await app.sees("fuse-e2e");
    await app.click(button("Work run"));
  });
  // F4: at a narrow, a medium and a wide window, the main controls and Send stay inside the box.
  for (const [w, h] of [
    [640, 600],
    [900, 700],
    [1400, 900],
  ] as const) {
    await step(`composer-${String(w)}`, async () => {
      await app.resize(w, h);
      await new Promise((r) => setTimeout(r, 500));
      const outside = await app.run<string[]>(`
        const box = document.querySelector('textarea[aria-label="Message"]').closest('.rounded-2xl').getBoundingClientRect();
        // The row clips what doesn't fit, so its controls must end inside the row itself.
        const row = document.querySelector('[data-composer-row]').getBoundingClientRect();
        const names = ["Choose model (Ctrl+K)", "Add a folder", "Coding run", "Work run"];
        const out = (n, edge) => {
          const b = document.querySelector('[aria-label="' + n + '"]');
          if (!b) return true;
          const r = b.getBoundingClientRect();
          return r.left < edge.left || r.right > edge.right;
        };
        return names.filter((n) => out(n, row))
          .concat(out("Send message (Enter)", box) ? ["Send message (Enter)"] : [])
          .concat(
          // Think is in the row, or in "More", whose button must be in the box too.
          ["Think harder", "More options"].some((n) => {
            const b = document.querySelector('[aria-label="' + n + '"]');
            if (!b) return false;
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.left >= box.left && r.right <= box.right;
          }) ? [] : ["Think harder or More options"],
        );`);
      expect(outside).toEqual([]);
    });
  }
  await app.unsize();
  const check = async (n: number, seen: number) => {
    await app.type(composer, `E2E check ${String(n)}`);
    await app.press("Enter");
    await app.click(
      '//*[@aria-label="Run this command?"]//button[normalize-space()="Allow"]',
      60_000,
    );
    return nextAnswer(seen);
  };
  await step("check-2-inside", async () => {
    const out = await check(2, 0);
    expect(out).toContain("[sandboxed, network off]");
    expect(out).toContain("exit code 0");
    expect(readFileSync(join(FOLDER, "inside.txt"), "utf8").trim()).toBe("hi");
  });
  await step("check-3-outside", async () => {
    const out = await check(3, 1);
    expect(out).toContain("Access is denied");
    expect(existsSync(escape)).toBe(false);
  });
  if (SERVER) {
    console.log("Check 5 skipped: Windows Server denies NUL to sandboxed apps.");
    return;
  }
  await step("check-5-nul", async () => {
    const out = await check(5, 2);
    expect(out).toContain("shown");
    expect(out).toContain("exit code 0");
  });
}, 300_000);
