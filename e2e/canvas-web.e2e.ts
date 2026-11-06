// M17.2 writing canvas in the shared web app, against this build's native database.
// Scripted replies only: no provider keys, no provider calls.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Session, button, byLabel } from "./driver";
const URL = process.env.FUSE_CANVAS_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "canvas");
let app: Session,
  profile = "";
async function themes(name: string) {
  for (const theme of ["light", "dark"]) {
    await app.run(
      `document.documentElement.classList.toggle('dark',${theme === "dark" ? "true" : "false"});`,
    );
    await new Promise((r) => setTimeout(r, 200));
    await app.screenshot(join(SHOTS, `${name}-${theme}.png`));
  }
  await app.run("document.documentElement.classList.remove('dark');");
}
async function query<T>(sql: string): Promise<T[]> {
  return app.run<T[]>(
    `const r=await fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:${JSON.stringify(sql)},params:[]})});if(!r.ok)throw new Error('Fixture query failed');return r.json();`,
  );
}
const panel = '//aside[@aria-label="Artifact: Canvas plan"]';
const tools = `${panel}//*[@aria-label="Writing tools"]`;

describe.skipIf(!URL || !BROWSER)("writing canvas in the shared web app", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-canvas-web-"));
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
    const pass = "a synthetic canvas fixture passphrase";
    await app.type('(//input[@type="password"])[1]', pass);
    await app.type('(//input[@type="password"])[2]', pass);
    await app.click(button("Set passphrase"));
    await app.find(byLabel("Message"));
    expect(await app.run("return document.documentElement.dataset.build;")).toBe(
      "fuse-e2e-scripted-build",
    );
    expect(await query("SELECT MAX(version) AS version FROM _sqlx_migrations")).toEqual([
      { version: 78 },
    ]);
    await app.click('//*[@aria-label="Area"]//button[normalize-space()="Chat"]');
    await app.click('//button[text()[normalize-space()="New chat"]]');
  }, 120000);
  afterAll(() => {
    const started = app as Session | undefined;
    if (started) {
      writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
      started.quit();
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  test("comment, Shorten as a reviewed proposal, accept as a new version", async () => {
    await app.type(byLabel("Message"), "E2E canvas draft");
    await app.press("Enter");
    await app.find(tools);
    await themes("document");

    // Comment on the Risks section.
    await app.run(
      `const s=document.querySelector('[aria-label="Section"]');s.value=[...s.options].find(o=>o.text==='Risks').value;s.dispatchEvent(new Event('change',{bubbles:true}));return true;`,
    );
    await app.click(`${tools}//button[@aria-label="Comment"]`);
    await app.type(byLabel("Comment text"), "Name the worst case");
    await app.press("Enter");
    await app.find(`${panel}//*[@aria-label="Comments"]`);
    expect(
      await query("SELECT body,quote LIKE '## Risks%' AS risks FROM artifact_comments"),
    ).toEqual([{ body: "Name the worst case", risks: 1 }]);

    // Shorten: the reply is a proposal, and nothing changes until it's accepted.
    await app.click(`${tools}//button[normalize-space()="Shorten"]`);
    await app.find(
      `${panel}//section[starts-with(@aria-label,"Proposal: Shorten")]//*[@aria-label="Changes"]`,
      60_000,
    );
    expect(await query("SELECT COUNT(*) AS n FROM artifact_versions")).toEqual([{ n: 1 }]);
    expect(await query("SELECT state FROM artifact_proposals")).toEqual([{ state: "pending" }]);
    await themes("proposal");

    await app.click(`${panel}//button[normalize-space()="Accept as new version"]`);
    await app.gone(`${panel}//section[starts-with(@aria-label,"Proposal:")]`);
    expect(await query("SELECT COUNT(*) AS n FROM artifact_versions")).toEqual([{ n: 2 }]);
    expect(
      await query(
        "SELECT p.state, v.content LIKE '%Edits can clash.%' AS shorter FROM artifact_proposals p JOIN artifact_versions v ON v.id=p.accepted_version_id",
      ),
    ).toEqual([{ state: "accepted", shorter: 1 }]);
    // The comment stays on version 1; its passage changed, so it offers no silent move.
    await app.sees("The passage isn't in the latest version.");
    expect(
      await query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM request_log WHERE billing_state='reported'",
      ),
    ).not.toEqual([{ n: 0 }]);
    await themes("accepted");
    writeFileSync(
      join(SHOTS, "result.json"),
      JSON.stringify(
        {
          schema: 74,
          versions: 2,
          comments: 1,
          proposals: await query("SELECT state FROM artifact_proposals"),
        },
        null,
        1,
      ),
    );
  }, 180000);
});
