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
      // M10 step 26: where it runs is a menu.
      await app.click('//button[starts-with(@aria-label, "Where it runs:")]');
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
  test("M12: Settings uses categories on desktop and a picker on narrow screens", async () => {
    await step("settings-general-light", async () => {
      await app.chord(",");
      await app.find('//nav[@aria-label="Settings categories"]');
      await app.click(button("General"));
      await app.find('//*[@aria-label="Theme"]');
      await app.click(button("Light"));
      await new Promise((done) => setTimeout(done, 250));
    });
    await step("settings-general-dark", async () => {
      await app.click(button("Dark"));
      await new Promise((done) => setTimeout(done, 250));
      expect(await app.run('return document.documentElement.classList.contains("dark");')).toBe(
        true,
      );
    });
    await step("settings-mobile", async () => {
      await app.resize(390, 844);
      await app.choose("Settings category", "Privacy & security");
      await app.find('//h2[normalize-space()="Privacy & security"]');
      expect(
        await app.run("return document.documentElement.scrollWidth <= window.innerWidth;"),
      ).toBe(true);
    });
    await app.resize(1280, 800);
    await app.click(button("General"));
    await app.click(button("Light"));
    await app.click(button("Back to Code"));
    await app.find(areas);
  });
  test("M12: Settings search finds aliases, focuses controls and excludes private draft content", async () => {
    await app.chord(",");
    const search = byLabel("Search settings");
    await step("settings-search-theme", async () => {
      await app.type(search, "dark mode");
      await app.find('//*[@role="option"][.//span[normalize-space()="Theme"]]');
      await app.press("Enter");
      await new Promise((done) => setTimeout(done, 300));
      expect(
        await app.run(`return Boolean(document.activeElement.closest('[aria-label="Theme"]'));`),
      ).toBe(true);
    });
    await step("settings-search-hulk", async () => {
      await app.type(search, "HULK");
      const text = await app.text(byLabel("Settings results"));
      expect(text).toContain("Run on HULK");
      expect(text).toContain("Encrypted sync");
    });
    await app.clear(search);
    await app.type(search, "About you");
    await app.press("Enter");
    await app.type(byLabel("About you"), "private-unique-sentinel-8472");
    await app.type(search, "private-unique-sentinel-8472");
    await app.find('//*[@role="status" and contains(.,"No settings found")]');
    await app.press("Escape");
    expect(await app.run(`return document.querySelector('[aria-label="About you"]').value;`)).toBe(
      "private-unique-sentinel-8472",
    );
    await step("settings-search-mobile", async () => {
      await app.resize(390, 844);
      await app.type(search, "recovery");
      const text = await app.text(byLabel("Settings results"));
      expect(text).toContain("Database recovery key");
      expect(text).toContain("Sync recovery");
      expect(
        await app.run("return document.documentElement.scrollWidth <= window.innerWidth;"),
      ).toBe(true);
    });
    await app.press("Escape");
    await app.resize(1280, 800);
    await app.click(button("Back to Code"));
  });
  test("M12: direct links, legacy sync, reload, history and palette open registered destinations", async () => {
    await step("settings-direct-instructions", async () => {
      await app.run('window.location.hash = "#settings/personalization/about-you";');
      await app.find(byLabel("About you"));
      await new Promise((done) => setTimeout(done, 250));
      expect(await app.run('return document.activeElement.getAttribute("aria-label");')).toBe(
        "About you",
      );
      await app.clear(byLabel("About you"));
      await app.type(byLabel("About you"), "A direct-link draft");
    });
    await app.click(button("General"));
    await app.run("window.history.back();");
    await app.find(byLabel("About you"));
    expect(await app.run(`return document.querySelector('[aria-label="About you"]').value;`)).toBe(
      "A direct-link draft",
    );
    await app.run("window.history.forward();");
    await app.find('//*[@aria-label="Appearance"]');
    await step("settings-legacy-sync", async () => {
      await app.run('window.location.hash = "#sync";');
      await app.find('//h2[normalize-space()="Sync & devices"]');
      await app.run('document.documentElement.dataset.m12Reload = "old";');
      await app.reload();
      await app.find("//html[not(@data-m12-reload)]");
      await app.find('//h2[normalize-space()="Sync & devices"]');
    });
    await step("settings-invalid-link", async () => {
      await app.run('window.location.hash = "#settings/unknown/private-sentinel";');
      await app.find('//*[@role="status" and contains(.,"Showing General")]');
      await app.find('//*[@aria-label="Appearance"]');
    });
    await app.click(button("Back to Code"));
    await app.run(
      'window.dispatchEvent(new KeyboardEvent("keydown", {key:"p", ctrlKey:true, shiftKey:true, bubbles:true}));',
    );
    await app.type(byLabel("Type a command or a chat"), "Routing policy");
    await app.press("Enter");
    await app.find('//*[@aria-label="Routing policy"]');
    expect(await app.run("return window.location.hash;")).toBe(
      "#settings/providers-models/routing-policy",
    );
    await app.run('window.location.hash = "#settings/privacy-security/database-recovery";');
    await app.find('//h2[normalize-space()="Privacy & security"]');
    await app.run('document.documentElement.dataset.m12Reload = "old";');
    await app.reload();
    await app.find("//html[not(@data-m12-reload)]");
    await app.find('//h2[normalize-space()="Privacy & security"]');
    await app.click(button("Back to Code"));
  });
  test("M12: light/dark layouts keep controls inside all supported widths", async () => {
    const labels = [
      "General",
      "Providers & models",
      "Personalization",
      "Costs & limits",
      "Code & tools",
      "Sync & devices",
      "Privacy & security",
      "Data & storage",
      "About & diagnostics",
    ];
    const reports: unknown[] = [];
    await app.chord(",");
    for (const [width, height] of [
      [640, 480],
      [1100, 750],
      [1600, 900],
      [390, 844],
    ]) {
      await app.resize(width, height);
      for (const theme of ["Light", "Dark"]) {
        if (width < 800) await app.choose("Settings category", "General");
        else await app.click(button("General"));
        await app.click(button(theme));
        await new Promise((done) => setTimeout(done, 250));
        await app.screenshot(join(SHOTS, `m12-${String(width)}-${theme.toLowerCase()}.png`));
        for (const label of labels) {
          if (width < 800) await app.choose("Settings category", label);
          else await app.click(button(label));
          await new Promise((done) => setTimeout(done, 100));
          const bounds = await app.run<{ pageWidth: number; outside: string[] }>(`
            const controls = [...document.querySelectorAll('input,select,textarea,button')]
              .filter(el => el.getClientRects().length && !el.closest('[inert],[hidden]'));
            return { pageWidth: document.documentElement.scrollWidth, outside: controls
              .filter(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; })
              .map(el => el.getAttribute('aria-label') || el.textContent.trim()) };`);
          reports.push({ width, height, theme, category: label, ...bounds });
          expect(bounds.pageWidth, `${String(width)} ${theme} ${label}`).toBeLessThanOrEqual(width);
          expect(bounds.outside, `${String(width)} ${theme} ${label}`).toEqual([]);
        }
      }
    }
    writeFileSync(join(SHOTS, "m12-layout-bounds.json"), JSON.stringify(reports, null, 2));
    await app.resize(1280, 800);
    await app.click(button("General"));
    await app.click(button("Light"));
    await app.click(button("Back to Code"));
  });
});
