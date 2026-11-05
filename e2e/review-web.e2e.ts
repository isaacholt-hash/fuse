// Shared production UI, native Git capture and background owner; synthetic model replies only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { button, byLabel, Session } from "./driver";
const URL = process.env.FUSE_REVIEW_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "review"),
  composer = '//textarea[@aria-label="Message"]';
let app: Session,
  profile = "";
async function themes(name: string) {
  for (const theme of ["light", "dark"]) {
    await app.run(
      `document.documentElement.classList.toggle('dark',${theme === "dark" ? "true" : "false"});`,
    );
    await new Promise((r) => setTimeout(r, 250));
    await app.screenshot(join(SHOTS, `${name}-${theme}.png`));
  }
}
describe.skipIf(!URL || !BROWSER)("pinned code review web fixture", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-review-browser-"));
    app = await Session.start(BROWSER, [
      "--headless=new",
      "--remote-debugging-port=9222",
      `--user-data-dir=${profile}`,
      "--window-size=1280,900",
      "--no-first-run",
      "--no-sandbox",
      "about:blank",
    ]);
    await app.resize(1280, 900);
    await app.navigate(URL);
    const pass = "a synthetic review fixture passphrase";
    await app.type('(//input[@type="password"])[1]', pass);
    await app.type('(//input[@type="password"])[2]', pass);
    await app.click(button("Set passphrase"));
    await app.find(composer);
    expect(await app.run("return document.documentElement.dataset.build;")).toBe(
      "fuse-e2e-scripted-build",
    );
    await app.click('//*[@aria-label="Area"]//button[normalize-space()="Code"]');
    await app.click(button("New session in Review fixture"));
    await app.find('//*[@aria-label="Project: Review fixture"]');
  }, 120000);
  afterAll(() => {
    const started = app as Session | undefined;
    if (started) {
      writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
      started.quit();
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });
  test("setup preserves the draft, pins a branch selection and explains GitHub without an enabled account", async () => {
    await app.type(composer, "Preserve this editable review draft.");
    await app.click(button("Options"));
    await app.click('//button[@aria-label="Review code"]');
    await app.find('//*[@role="dialog"]//*[normalize-space()="Review code"]');
    expect(
      await app.run(
        'return document.querySelector("textarea[aria-label=\\"Review focus\\"]").value;',
      ),
    ).toBe("Preserve this editable review draft.");
    await themes("local-setup");
    await app.choose("Review source", "Branch comparison");
    await app.type(byLabel("Review base"), "fixture");
    await themes("branch-setup");
    await app.choose("Review source", "GitHub pull request");
    await app.find('//*[contains(text(),"enable GitHub for this project")]');
    await themes("github-unavailable");
    await app.click(button("Cancel"));
    expect(
      await app.run('return document.querySelector("textarea[aria-label=\\"Message\\"]").value;'),
    ).toBe("Preserve this editable review draft.");
    const counts = await app.run(
      `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:'SELECT (SELECT COUNT(*) FROM runs) AS runs,(SELECT COUNT(*) FROM request_log) AS requests',params:[]})}).then(r=>r.json());`,
    );
    expect(counts).toEqual([{ runs: 0, requests: 0 }]);
  }, 120000);
  test("explicit review completes through HULK with verified findings and no repository changes", async () => {
    await app.click(button("Options"));
    await app.click('//button[@aria-label="Review code"]');
    await app.clear(byLabel("Review focus"));
    await app.type(byLabel("Review focus"), "Review the changed divisor for den=1.");
    await app.clear(byLabel("Review spending cap"));
    await app.type(byLabel("Review spending cap"), "5");
    await app.click(button("Start read-only review"));
    await app.find('//*[contains(text(),"Preserve the original divisor")]', 90000);
    await app.find('//*[contains(text(),"Locations and quoted evidence were checked")]');
    const sessionSettings = await app.run(
      `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:"SELECT run_mode,run_cap_micro_usd FROM threads WHERE title LIKE 'Review:%'",params:[]})}).then(r=>r.json());`,
    );
    expect(sessionSettings).toEqual([{ run_mode: "plan", run_cap_micro_usd: 5000000 }]);
    await themes("review-result");
    const result = await app.run(
      `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:"SELECT (SELECT COUNT(*) FROM runs WHERE review_profile=1 AND mode='plan' AND status='done') AS reviews,(SELECT COUNT(*) FROM request_log WHERE purpose='agent') AS requests,(SELECT COUNT(*) FROM run_changes) AS changes,(SELECT COUNT(*) FROM folders) AS folders,(SELECT SUM(cost_micro_usd) FROM request_log WHERE purpose='agent') AS costMicroUsd",params:[]})}).then(r=>r.json());`,
    );
    expect(result).toEqual([
      expect.objectContaining({ reviews: 1, requests: 3, changes: 0, folders: 1 }),
    ]);
    writeFileSync(
      join(SHOTS, "result.json"),
      JSON.stringify(
        { synthetic: true, liveProviderCalls: 0, executionOwner: "HULK runner", result },
        null,
        2,
      ),
    );
    await app.click(button("Collapse sidebar (Ctrl+B)"));
    await app.resize(390, 844);
    await app.find('//*[contains(text(),"Preserve the original divisor")]');
    await themes("review-mobile");
    expect(
      await app.run(
        "return document.documentElement.scrollWidth<=document.documentElement.clientWidth;",
      ),
    ).toBe(true);
  }, 120000);
});
