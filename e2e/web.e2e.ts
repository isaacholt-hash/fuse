// M10 steps 11 to 17 in the web app: the checklist items that need no model, clicked through in
// headless Chrome against a throwaway fuse-server (CI's "Runs on HULK benchmark" job starts it;
// see e2e/README.md). Runs on HULK, the model and the runner are the benchmark's part. Skipped
// unless FUSE_WEB_URL and FUSE_WEB_BROWSER are set. Screenshots go in e2e/screenshots/web/.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { button, byLabel, Session } from "./driver";

const URL = process.env.FUSE_WEB_URL ?? "";
const BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "web");
const PROJECT = "Checklist";
const TASK = "Nightly checklist task";
/** The area switch: there from sign-in on (the composer asks for a key, which this server has none of). */
const areas = '//*[@aria-label="Area"]';
/** The throwaway server's passphrase: it lives only as long as the test's server. */
const PASS = "a long throwaway passphrase for the web test";

let app: Session;
let profile = "";
let shot = 0;

async function step(name: string, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    const alerts = await app.run<string[]>(
      "return [...document.querySelectorAll('[role=alert]')].map((e) => e.innerText.trim()).filter(Boolean);",
    );
    for (const a of alerts) app.console.push(`after ${name}, alert: ${a}`);
    await app.screenshot(join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`));
  }
}

const pressed = (name: "Chat" | "Code") =>
  `//*[@aria-label="Area"]//button[@aria-pressed="true" and normalize-space()="${name}"]`;

describe.skipIf(!URL || !BROWSER)("the web app", () => {
  beforeAll(async () => {
    rmSync(SHOTS, { recursive: true, force: true });
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-web-e2e-"));
    app = await Session.start(BROWSER, [
      "--headless=new",
      "--remote-debugging-port=9222",
      `--user-data-dir=${profile}`,
      "--window-size=1280,800",
      "--no-first-run",
      "--no-default-browser-check",
      // Ubuntu 24.04 blocks the user namespaces Chrome's sandbox needs. This browser only ever
      // opens the test's own server on localhost.
      "--no-sandbox",
      "about:blank",
    ]);
    await app.navigate(URL);
    // A fresh server asks for a passphrase first.
    await step("sign-in", async () => {
      await app.type('(//input[@type="password"])[1]', PASS);
      await app.type('(//input[@type="password"])[2]', PASS);
      await app.click(button("Set passphrase"));
      await app.find(areas, 60_000);
    });
  }, 120_000);

  afterAll(() => {
    const started = app as Session | undefined;
    if (started) {
      writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
      started.quit();
    }
    // Chrome may still be writing its profile as it closes.
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  test("set up: a project", async () => {
    await step("project", async () => {
      await app.click(button("New project"));
      await app.type('//input[@placeholder="e.g. Kitchen renovation"]', PROJECT);
      await app.click(button("Create project"));
      await app.gone(button("Create project"));
    });
  });

  test("1. Ctrl+2 and Ctrl+1 switch areas; only Code has the new-session bar", async () => {
    await step("areas", async () => {
      await app.chord("2");
      await app.find(pressed("Code"));
      await app.find("//*[@data-new-session]");
      await app.chord("1");
      await app.find(pressed("Chat"));
      await app.gone("//*[@data-new-session]");
      // And by clicking, as on a phone.
      await app.click('//*[@aria-label="Area"]//button[normalize-space()="Code"]');
      await app.find(pressed("Code"));
    });
  });

  test("3. a new session in the web app runs on HULK; This computer is greyed with why", async () => {
    await step("where", async () => {
      await app.chord("n");
      await app.choose("Project or repository", PROJECT);
      const here = '//*[@aria-label="Where it runs"]//button[normalize-space()="This computer"]';
      await app.find(here);
      const greyed = await app.run<{ disabled: boolean; title: string }>(`
        const b = document.evaluate(${JSON.stringify(here)}, document, null,
          XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return { disabled: b.disabled, title: b.title };`);
      expect(greyed.disabled).toBe(true);
      expect(greyed.title).toContain("HULK");
      await app.find(
        '//*[@aria-label="Where it runs"]//button[@aria-pressed="true" and normalize-space()="HULK"]',
      );
    });
  });

  test("7. the Scheduled page adds a task, then pauses and resumes it", async () => {
    await step("scheduled-add", async () => {
      await app.click('//button[normalize-space()="Scheduled"]');
      await app.sees("Scheduled tasks");
      await app.choose("Project for the new task", PROJECT);
      await app.click(button("New task"));
      await app.type('//input[@placeholder="e.g. Morning dependency check"]', TASK);
      await app.type(
        '//textarea[@placeholder="e.g. Update the dependencies, run the tests, and summarise what changed."]',
        "Run the tests and say what failed.",
      );
      await app.click(button("Add task"));
      await app.gone(button("Add task"));
      const list = byLabel("Every scheduled task");
      expect(await app.text(list)).toContain(TASK);
      expect(await app.text(list)).toContain("Active");
    });
    await step("scheduled-pause", async () => {
      await app.click(button(`Pause ${TASK}`));
      await app.find(button(`Resume ${TASK}`));
      expect(await app.text(byLabel("Every scheduled task"))).toContain("Paused");
    });
    await step("scheduled-resume", async () => {
      await app.click(button(`Resume ${TASK}`));
      await app.find(button(`Pause ${TASK}`));
      expect(await app.text(byLabel("Every scheduled task"))).toContain("Active");
      await app.click(button("Back to sessions"));
      await app.find(areas);
    });
  });

  test("8. Usage opens in the web app", async () => {
    await step("usage", async () => {
      await app.click('//button[normalize-space()="Usage"]');
      await app.sees("Usage");
    });
  });
});
