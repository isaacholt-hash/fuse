// A separate scripted build: real UI/storage, synthetic capture and receipts, no provider call.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { button, byLabel, Session } from "./driver";

const URL = process.env.FUSE_DICTATION_WEB_URL ?? "";
const BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "dictation");
const composer = '//textarea[@aria-label="Message"]';
let app: Session;
let profile = "";
describe.skipIf(!URL || !BROWSER)("dictation web fixture", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-dictation-web-"));
    app = await Session.start(BROWSER, [
      "--headless=new",
      "--remote-debugging-port=9222",
      `--user-data-dir=${profile}`,
      "--window-size=1280,800",
      "--no-first-run",
      "--no-sandbox",
      "about:blank",
    ]);
    await app.resize(1280, 800);
    await app.navigate(URL);
    const pass = "a synthetic dictation fixture passphrase";
    await app.type('(//input[@type="password"])[1]', pass);
    await app.type('(//input[@type="password"])[2]', pass);
    await app.click(button("Set passphrase"));
    await app.find(composer);
    expect(await app.run("return document.documentElement.dataset.build;")).toBe(
      "fuse-e2e-scripted-build",
    );
    await app.run('localStorage.setItem("fuse.e2e.dictation", "yes");');
    await app.reload();
    await app.find(composer);
  }, 120_000);
  afterAll(() => {
    const started = app as Session | undefined;
    if (started) {
      writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
      started.quit();
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });
  test("consent, editable transcript, no send, settings and cancellation in both themes", async () => {
    await app.click('//*[@aria-label="Area"]//button[normalize-space()="Chat"]');
    await app.click('//button[text()[normalize-space()="New chat"]]');
    await app.gone("//*[@data-answer]");
    await app.click('//button[@aria-label="Dictate"]');
    await app.find('//*[@role="dialog"]');
    await app.screenshot(join(SHOTS, "web-consent-light.png"));
    await app.click(button("Agree to audio transfer"));
    await app.gone('//*[@role="dialog"]');
    await app.type(composer, "Keep this draft.");
    await app.click('//button[@aria-label="Dictate"]');
    await app.find('//button[@aria-label="Stop recording and transcribe"]');
    await app.screenshot(join(SHOTS, "web-recording-light.png"));
    await app.click('//button[@aria-label="Stop recording and transcribe"]');
    await app.sees("Transcript added to your draft.");
    expect(
      await app.run(`return document.querySelector('textarea[aria-label="Message"]').value;`),
    ).toBe("Keep this draft.\n\nA dictated fixture, ready to edit.");
    expect(await app.run('return document.querySelectorAll("[data-answer]").length;')).toBe(0);
    await app.screenshot(join(SHOTS, "web-transcript-light.png"));
    await app.chord(",");
    await app.type(byLabel("Search settings"), "dictation");
    await app.press("Enter");
    await app.find('//button[@aria-label="Turn off dictation"]');
    await app.run(
      `document.querySelector('[data-settings-control="dictation-consent"]').scrollIntoView({block:"center"});`,
    );
    await app.screenshot(join(SHOTS, "web-settings-light.png"));
    await app.run('window.location.hash = "#settings/general/appearance";');
    await app.click(button("Dark"));
    await app.chord(",");
    await app.find(composer);
    await app.click('//button[@aria-label="Dictate"]');
    await app.find('//button[@aria-label="Stop recording and transcribe"]');
    await app.screenshot(join(SHOTS, "web-recording-dark.png"));
    await app.chord(","); // Hidden composer releases capture; it cannot continue behind Settings.
    await app.run('window.location.hash = "#settings/general/dictation";');
    await app.find('//button[@aria-label="Turn off dictation"]');
    await app.run(
      `document.querySelector('[data-settings-control="dictation-consent"]').scrollIntoView({block:"center"});`,
    );
    await app.screenshot(join(SHOTS, "web-settings-dark.png"));
    await app.click('//button[@aria-label="Turn off dictation"]');
    await app.chord(",");
    await app.find(composer);
    expect(
      await app.run(`return document.querySelector('textarea[aria-label="Message"]').value;`),
    ).toContain("Keep this draft.");
    await app.click('//button[@aria-label="Dictate"]');
    await app.find('//*[@role="dialog"]');
    await app.screenshot(join(SHOTS, "web-consent-dark.png"));
    writeFileSync(
      join(SHOTS, "result.json"),
      JSON.stringify(
        {
          verifiedOn: "2026-11-05",
          surface: "web",
          audio: "synthetic fixture",
          providerCalls: 0,
          automaticMessages: 0,
          reportedFixtureCostMicroUsd: 75,
          themes: ["light", "dark"],
          result: "passed",
        },
        null,
        2,
      ) + "\n",
    );
  });
});
