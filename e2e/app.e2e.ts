// M8 step 14: FUSE driven like a person would use it, over WebView2's DevTools port, on the test build
// (scripted models, fake keys and update; src/e2e/deps.ts). Run by CI on Windows: see
// e2e/README.md. Each step leaves a screenshot in e2e/screenshots/.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** M9 step 6: the Python check, on Isaac's PC only (it installs Python, a 47 MB download). */
const PYTHON = process.env.FUSE_E2E_PYTHON === "1";

let app: Session;
let shot = 0;

async function step(name: string, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    // Errors the app showed (report() puts them on screen, not in the console).
    const alerts = await app.run<string[]>(
      "return [...document.querySelectorAll('[role=alert]')].map((e) => e.innerText.trim()).filter(Boolean);",
    );
    for (const a of alerts) app.console.push(`after ${name}, alert: ${a}`);
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
    // M9 step 6: the scripted model says so when run_python isn't offered.
    if (last?.includes("wasn't offered")) return last;
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
  // A fresh start each run: the test build's own data (never FUSE's), which a reused PC keeps.
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (base) rmSync(join(base, "com.isaacholt.fuse.e2e"), { recursive: true, force: true });
  }
  app = await Session.start(APP);
  await app.find(composer, 60_000);
  // Never drive a real build: only the test build has scripted models.
  expect(await app.run<string>("return document.documentElement.dataset.build ?? '';")).toBe(
    "fuse-e2e-scripted-build",
  );
}, 120_000);

afterAll(() => {
  // Unset when the app didn't start.
  const started = app as Session | undefined;
  if (!started) return;
  writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
  started.quit();
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

test.skipIf(!PYTHON)(
  "M9 step 6: Python installs, then a Work run's script runs in the Windows sandbox",
  async () => {
    for (const f of ["py-summary.csv", "sneaky.txt"]) rmSync(join(FOLDER, f), { force: true });
    writeFileSync(join(FOLDER, "data.csv"), "region,total\nnorth,12\nsouth,30\n");
    await step("python-install", async () => {
      await app.chord(",");
      await app.find('//section[@aria-label="Python for data work"]');
      await app.run(
        'document.querySelector(\'[aria-label="Python for data work"]\').scrollIntoView({ block: "center" }); return true;',
      );
      await app.click(
        '//section[@aria-label="Python for data work"]//button[normalize-space()="Install"]',
      );
      // The download, then the libraries from PyPI.
      await app.sees("is installed", 600_000);
      await app.chord(",");
      await app.find(composer);
    });
    await step("python-run", async () => {
      await app.chord("n");
      await app.click(button("Add a folder"));
      await app.sees("fuse-e2e");
      await app.click(button("Work run"));
      await app.type(composer, "E2E python");
      await app.press("Enter");
      await app.click(
        '//*[@aria-label="Run this Python script?"]//button[normalize-space()="Allow"]',
        60_000,
      );
      const out = await nextAnswer(0);
      expect(out).toContain("total 42");
      expect(out).toContain("folder read-only: PermissionError");
      expect(out).toContain("[sandboxed, network off]");
      expect(out).toMatch(/chart\.png \(\d+ KB, shown\)/);
      expect(out).toContain("Created py-summary.csv");
      expect(readFileSync(join(FOLDER, "py-summary.csv"), "utf8")).toContain("south,30");
      expect(existsSync(join(FOLDER, "sneaky.txt"))).toBe(false);
    });
  },
  900_000,
);
