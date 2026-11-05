// Shared production UI, native encrypted database, synthetic public account states; no OAuth/provider calls.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { button, byLabel, Session } from "./driver";
const URL = process.env.FUSE_CONNECTORS_WEB_URL ?? "";
const BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "connectors");
const section = '//*[@data-settings-section="connectors"]';
const card = (kind: string) => `${section}//article[starts-with(@aria-label,"${kind}")]`;
let app: Session,
  profile = "";
async function themes(name: string) {
  for (const theme of ["light", "dark"]) {
    await app.run(
      `document.documentElement.classList.toggle('dark',${theme === "dark" ? "true" : "false"});`,
    );
    await new Promise((done) => setTimeout(done, 250));
    await app.screenshot(join(SHOTS, `${name}-${theme}.png`));
  }
}
describe.skipIf(!URL || !BROWSER)("connector setup web fixture", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-connectors-web-"));
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
    const pass = "a synthetic connector fixture passphrase";
    await app.type('(//input[@type="password"])[1]', pass);
    await app.type('(//input[@type="password"])[2]', pass);
    await app.click(button("Set passphrase"));
    await app.find('//textarea[@aria-label="Message"]');
    expect(await app.run("return document.documentElement.dataset.build;")).toBe(
      "fuse-e2e-scripted-build",
    );
    await app.click(button("New project"));
    await app.type('//input[@placeholder="e.g. Kitchen renovation"]', "Reader fixture");
    await app.click(button("Create project"));
    await app.gone(button("Create project"));
    await app.find(byLabel("Project: Reader fixture"));
    await app.run('window.location.hash="#settings/code-tools/connectors";');
    await app.find(`${section}//*[normalize-space()="Connections"]`);
    writeFileSync(
      join(SHOTS, "initial.json"),
      JSON.stringify(
        await app.run(
          `return {text:document.body.innerText,section:document.querySelector('[data-settings-section="connectors"]').outerHTML};`,
        ),
        null,
        2,
      ),
    );
    await app.screenshot(join(SHOTS, "initial.png"));
  }, 120000);
  afterAll(() => {
    const started = app as Session | undefined;
    if (started) {
      writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
      started.quit();
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });
  test("explicit selective Microsoft consent and project enablement without a folder", async () => {
    await app.click(button("Add Microsoft account"));
    await app.type(
      '//form[@aria-label="Connector registration"]//label[span="Application client ID"]//input',
      "10000000-0000-4000-8000-000000000001",
    );
    expect(
      await app.run(
        `return [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save registration').disabled;`,
      ),
    ).toBe(true);
    await app.click('//label[normalize-space()="OneDrive files"]//input');
    await app.click('//label[normalize-space()="Outlook Mail"]//input');
    await app.click('//label[normalize-space()="Outlook Calendar"]//input');
    await themes("registration");
    await app.click(button("Save registration"));
    await app.find(`${card("Microsoft")}//*[normalize-space()="Signed out"]`);
    expect(
      await app.run(
        `return document.querySelector('[data-settings-section="connectors"] article input[type="checkbox"]').disabled;`,
      ),
    ).toBe(true);
    await app.click(`${card("Microsoft")}//button[normalize-space()="Sign in"]`);
    await app.find(byLabel("Device sign-in code"));
    await themes("device-code");
    await app.find(`${card("Microsoft")}//*[normalize-space()="Connected"]`, 15000);
    const project = `${card("Microsoft")}//label[normalize-space()="Reader fixture"]//input`;
    await app.click(project);
    for (let attempt = 0; attempt < 30; attempt++) {
      if (
        await app.run(
          `return document.querySelector('[data-settings-section="connectors"] article input[type="checkbox"]').checked;`,
        )
      )
        break;
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(
      await app.run(
        `return document.querySelector('[data-settings-section="connectors"] article input[type="checkbox"]').checked;`,
      ),
    ).toBe(true);
    await app.find(card("Microsoft"));
    await themes("microsoft-connected");
  });
  test("GitHub consent denial, explicit retry, and account removal", async () => {
    await app.click(button("Add GitHub account"));
    await app.type(
      '//form[@aria-label="Connector registration"]//label[span="Application client ID"]//input',
      "Iv23.fixture",
    );
    await app.click(button("Save registration"));
    await app.run('localStorage.setItem("fuse.e2e.connectorOutcome","denied");');
    await app.click(`${card("GitHub")}//button[normalize-space()="Sign in"]`);
    await app.find(`${card("GitHub")}//*[contains(.,"Consent denied") and @role="status"]`, 15000);
    await themes("denied");
    await app.run('localStorage.removeItem("fuse.e2e.connectorOutcome");');
    await app.click(`${card("GitHub")}//button[normalize-space()="Sign in"]`);
    await app.find(`${card("GitHub")}//*[normalize-space()="Connected"]`, 15000);
    await themes("github-connected");
    await app.click(`${card("GitHub")}//button[normalize-space()="Remove…"]`);
    await app.find('//*[@role="alertdialog" and @aria-label="Remove connector account"]');
    await themes("remove-review");
    await app.click(button("Remove account"));
    await app.gone(card("GitHub"));
  });
  test("account switch clears permissions; narrow layouts and search remain usable; no provider/run execution", async () => {
    await app.run('localStorage.setItem("fuse.e2e.connectorAccount","work");');
    await app.click(
      `${card("Microsoft")}//button[normalize-space()="Change account and reset project access"]`,
    );
    await app.find(`${card("Microsoft")}//*[normalize-space()="Connected"]`, 15000);
    await app.find(`${section}//article[@aria-label="Microsoft · owner@organization.test"]`);
    expect(
      await app.run(
        `return document.querySelector('[data-settings-section="connectors"] article input[type="checkbox"]').checked;`,
      ),
    ).toBe(false);
    await app.resize(390, 844);
    await app.find(card("Microsoft"));
    await themes("mobile");
    expect(await app.run("return document.documentElement.scrollWidth<=window.innerWidth;")).toBe(
      true,
    );
    await app.type(byLabel("Search settings"), "GitHub");
    await app.find('//*[@role="option"][.//span[normalize-space()="Connections"]]');
    await app.click('//*[@role="option"][.//span[normalize-space()="Connections"]]');
    await app.find(card("Microsoft"));
    const counts = await app.run<{
      requests: number;
      runs: number;
      folders: number;
      links: number;
    }>(
      `const ask=async(sql)=>{const res=await fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql,params:[]})});if(!res.ok)throw new Error('fixture query failed');return (await res.json())[0].n;};return {requests:await ask('SELECT count(*) n FROM request_log'),runs:await ask('SELECT count(*) n FROM runs'),folders:await ask('SELECT count(*) n FROM folders'),links:await ask('SELECT count(*) n FROM project_mcp_servers')};`,
    );
    expect(counts).toEqual({ requests: 0, runs: 0, folders: 0, links: 0 });
    writeFileSync(
      join(SHOTS, "result.json"),
      JSON.stringify(
        { synthetic: true, liveProviderCalls: 0, liveOAuthCalls: 0, ...counts },
        null,
        2,
      ) + "\n",
    );
  });
});
