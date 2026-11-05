// Shared UI and native database; synthetic provider availability, no real credentials or provider calls.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { button, byLabel, Session } from "./driver";
const URL = process.env.FUSE_SKILLS_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "skills");
let app: Session,
  profile = "";
const section = '//*[@data-settings-section="skills"]';
async function themes(name: string) {
  for (const theme of ["light", "dark"]) {
    await app.run(
      `document.documentElement.classList.toggle('dark',${theme === "dark" ? "true" : "false"});`,
    );
    await new Promise((r) => setTimeout(r, 200));
    await app.screenshot(join(SHOTS, `${name}-${theme}.png`));
  }
}
async function upload(name: string, text: string) {
  await app.run(
    `const input=document.querySelector('input[aria-label="Choose skill package"]');const files=new DataTransfer();files.items.add(new File([${JSON.stringify(text)}],${JSON.stringify(name)},{type:'text/markdown'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));`,
  );
  await app.find(byLabel("Skill import preview"));
}
describe.skipIf(!URL || !BROWSER)("named skill library in the shared web app", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-skills-web-"));
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
    const pass = "a synthetic skills fixture passphrase";
    await app.type('(//input[@type="password"])[1]', pass);
    await app.type('(//input[@type="password"])[2]', pass);
    await app.click(button("Set passphrase"));
    await app.find(byLabel("Message"));
    await app.click(button("New project"));
    await app.type('//input[@placeholder="e.g. Kitchen renovation"]', "Skill fixture");
    await app.click(button("Create project"));
    await app.gone(button("Create project"));
    await app.find(byLabel("Project: Skill fixture"));
    await new Promise((r) => setTimeout(r, 300));
    await app.run('window.location.hash="#settings/personalization/skills";');
    await app.find(`${section}//h2[normalize-space()="Skills"]`);
  }, 120000);
  afterAll(() => {
    const started = app as Session | undefined;
    if (started) {
      writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
      started.quit();
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });
  test("preview, cancel and explicit import keep packages inert and scope visible", async () => {
    await app.type(byLabel("Skill name"), "release-notes");
    await upload(
      "SKILL.md",
      "# Release notes\n\nWrite concise notes with evidence and limitations. Supporting scripts never grant permission.",
    );
    await themes("import-preview");
    await app.click(button("Cancel import"));
    await app.gone(byLabel("Skill import preview"));
    expect(
      await app.run("return document.querySelector('[aria-label=\"Imported skills\"]')===null;"),
    ).toBe(true);
    await upload(
      "SKILL.md",
      "# Release notes\n\nWrite concise notes with evidence and limitations. Supporting scripts never grant permission.",
    );
    await app.click(button("Import skill"));
    await app.find(byLabel("Imported skills"));
    await app.gone(byLabel("Skill import preview"));
    await themes("library");
  });
  test("named selection preserves draft, is not execution, and deletion requires confirmation", async () => {
    await app.click(button("Back to Chat"));
    await app.find(byLabel("Message"));
    await app.type(byLabel("Message"), "Keep this editable draft.");
    // Select the explicit named palette action; appending a package never sends the draft.
    await app.run(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'p',ctrlKey:true,shiftKey:true,bubbles:true}));",
    );
    await app.find('//*[@role="dialog"]');
    await app.type('//*[@role="dialog"]//input', "/skill release-notes");
    await app.click(
      '//*[@role="dialog"]//*[contains(normalize-space(),"/skill release-notes") and @role="option"]',
    );
    const draft = await app.run<string>(
      "return document.querySelector('textarea[aria-label=\"Message\"]').value;",
    );
    expect(draft).toMatch(/^\/skill release-notes@[0-9a-f-]{36}\nKeep this editable draft\.$/);
    await themes("editable-invocation");
    await app.click(button("Collapse sidebar (Ctrl+B)"));
    await app.resize(390, 844);
    await themes("mobile-invocation");
    await app.resize(1280, 900);
    const unavailable = "/skill unavailable\nKeep this request editable.";
    await app.type(byLabel("Message"), unavailable, true);
    await app.press("Enter");
    await app.find('//*[@role="alert" and contains(.,"No skill with that name")]');
    expect(
      await app.run("return document.querySelector('textarea[aria-label=\"Message\"]').value;"),
    ).toBe(unavailable);
    await themes("unavailable-draft");
    await app.click(byLabel("Dismiss"));
    const counts = await app.run(
      `const ask=async(sql)=>{const r=await fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql,params:[]})});if(!r.ok)throw new Error('fixture query failed');return(await r.json())[0].n;};return {packages:await ask('SELECT COUNT(*) n FROM skills'),versions:await ask('SELECT COUNT(*) n FROM skill_versions'),requests:await ask('SELECT COUNT(*) n FROM request_log'),runs:await ask('SELECT COUNT(*) n FROM runs'),folders:await ask('SELECT COUNT(*) n FROM folders')};`,
    );
    expect(counts).toEqual({ packages: 1, versions: 1, requests: 0, runs: 0, folders: 0 });
    writeFileSync(
      join(SHOTS, "result.json"),
      JSON.stringify({ synthetic: true, liveProviderCalls: 0, counts }, null, 2),
    );
    await app.run('window.location.hash="#settings/personalization/skills";');
    await app.find(byLabel("Imported skills"));
    await app.click(byLabel("Delete skill release-notes"));
    await app.find(button("Delete package"));
    await themes("delete-review");
    await app.click(button("Cancel"));
    await app.find(byLabel("Imported skills"));
  });
});
