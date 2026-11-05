// Real browser and HULK runner path; all sources/model replies and secrets are isolated fixtures.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { button, byLabel, Session } from "./driver";
const URL = process.env.FUSE_RESEARCH_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "research"),
  composer = '//textarea[@aria-label="Message"]';
let app: Session,
  profile = "";
describe.skipIf(!URL || !BROWSER)("research web fixture", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-research-web-"));
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
    const pass = "a synthetic research fixture passphrase";
    await app.type('(//input[@type="password"])[1]', pass);
    await app.type('(//input[@type="password"])[2]', pass);
    await app.click(button("Set passphrase"));
    await app.find(composer);
    expect(await app.run("return document.documentElement.dataset.build;")).toBe(
      "fuse-e2e-scripted-build",
    );
  }, 120000);
  afterAll(() => {
    const started = app as Session | undefined;
    if (started) {
      writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
      started.quit();
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });
  test("required cap, reviewed setup, explicit continuation and cited report through the background owner", async () => {
    await app.click('//*[@aria-label="Area"]//button[normalize-space()="Chat"]');
    await app.type(composer, "Keep this research draft.");
    await app.click(button("Options"));
    await app.click('//button[@aria-label="Research"]');
    await app.find('//*[@role="dialog" and .//*[normalize-space()="Research"]]');
    expect(
      await app.run(
        'return document.querySelector("input[aria-label=\\"Research spending cap (USD)\\"]").value;',
      ),
    ).toBe("");
    expect(
      await app.run(
        'return [...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Start research").disabled;',
      ),
    ).toBe(true);
    await app.clear('//textarea[@aria-label="Research scope"]');
    await app.type(
      '//textarea[@aria-label="Research scope"]',
      "Compare recorded tidal measurements and their limitations.",
    );
    await app.screenshot(join(SHOTS, "setup-light.png"));
    await app.run('document.documentElement.classList.add("dark");');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.screenshot(join(SHOTS, "setup-dark.png"));
    await app.type('//input[@aria-label="Research spending cap (USD)"]', "5");
    await app.click(button("Start research"));
    await app.find(byLabel("Research progress"), 20000);
    await app.click(button("Pause research"));
    await app.find(button("Continue research"), 20000);
    await app.screenshot(join(SHOTS, "paused-dark.png"));
    await app.click(button("Continue research"));
    await app.clear('//input[@aria-label="Continue research total cap (USD)"]');
    await app.type('//input[@aria-label="Continue research total cap (USD)"]', "5.50");
    await app.click('//*[@role="dialog"]//button[normalize-space()="Continue research"]');
    await app.sees("Research complete.", 30000);
    await app.find(
      '//*[@aria-label="Research progress"]//*[contains(normalize-space(), "· Finished")]',
    );
    await app.gone('//*[normalize-space()="Generating response"]');
    expect(
      await app.run('return document.querySelector("textarea[aria-label=\\"Message\\"]").value;'),
    ).toBe("Keep this research draft.");
    await app.click('//button[@aria-label="Open Research report"]');
    await app.find('//*[@aria-label="Artifact: Research report"]');
    await app.sees("The recorded measurement is two metres.");
    await app.screenshot(join(SHOTS, "report-dark.png"));
    await app.run('document.documentElement.classList.remove("dark");');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.screenshot(join(SHOTS, "report-light.png"));
    const receipt = await app.run<{
      calls: number;
      cost: number;
      runCost: number;
      cap: number;
      changes: number;
      folders: number;
    }>(
      `const ask=async(sql)=>{const res=await fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql,params:[]})});if(!res.ok)throw new Error('fixture query failed');return res.json();};const rows=await ask("SELECT COUNT(*) calls,SUM(cost_micro_usd) cost FROM request_log WHERE purpose='agent'");const run=(await ask("SELECT spent_micro_usd cost,cap_micro_usd cap FROM runs WHERE kind='research'"))[0];return {calls:rows[0].calls,cost:rows[0].cost,runCost:run.cost,cap:run.cap,changes:(await ask('SELECT COUNT(*) n FROM run_changes'))[0].n,folders:(await ask('SELECT COUNT(*) n FROM folders'))[0].n};`,
    );
    expect(receipt).toMatchObject({ calls: 4, cap: 5_500_000, changes: 0, folders: 0 });
    expect(receipt.cost).toBe(receipt.runCost);
    writeFileSync(
      join(SHOTS, "result.json"),
      JSON.stringify({ synthetic: true, liveProviderCalls: 0, ...receipt }, null, 2) + "\n",
    );
  }, 120000);
});
