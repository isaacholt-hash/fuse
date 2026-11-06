// M17.3 Python artifact runs in the shared web app, executed by the native server's sandbox.
// Scripted replies and a test-only system-Python link: no provider keys or calls.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Session, button, byLabel } from "./driver";
const URL = process.env.FUSE_ARTIFACT_RUN_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "artifact-runs");
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
const panel = '//aside[@aria-label="Artifact: Totals"]';
const approval = '//*[@role="alertdialog" and @aria-label="Run this Python script?"]';

describe.skipIf(!URL || !BROWSER)("Python artifact runs in the shared web app", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-artifact-run-web-"));
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
    const pass = "a synthetic artifact run passphrase";
    await app.type('(//input[@type="password"])[1]', pass);
    await app.type('(//input[@type="password"])[2]', pass);
    await app.click(button("Set passphrase"));
    await app.find(byLabel("Message"));
    expect(await query("SELECT MAX(version) AS version FROM _sqlx_migrations")).toEqual([
      { version: 77 },
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

  test("approve, run in the sandbox with a read-only input, keep provenance per attempt", async () => {
    await app.type(byLabel("Message"), "E2E artifact script");
    await app.press("Enter");
    await app.click(`${panel}//button[@aria-label="Run script"]`);
    await app.find(approval);
    await app.run(
      `const input=document.querySelector('input[aria-label="Input files"]');const files=new DataTransfer();files.items.add(new File(["north,12\\nsouth,30\\n"],"data.csv",{type:'text/csv'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;`,
    );
    await themes("approval");
    await app.click(`${approval}//button[normalize-space()="Allow once"]`);
    await app.find(
      `${panel}//*[@aria-label="Run output"]//*[contains(.,"Finished (exit 0)")]`,
      60_000,
    );
    const printed = await app.text(`${panel}//*[@aria-label="Printed output"]`);
    expect(printed).toContain("total 42");
    expect(printed).toContain("input read-only");
    expect(printed).toContain("network off");
    await app.sees("summary.csv");
    await themes("output");

    // A second approval is a second attempt; the first stays as it was.
    await app.click(`${panel}//button[@aria-label="Run script"]`);
    await app.click(`${approval}//button[normalize-space()="Allow once"]`);
    await app.find(`${panel}//select[@aria-label="Attempt"]`, 60_000);
    const runs = await query<{ attempt: number; state: string; inputs: string; outputs: string }>(
      "SELECT attempt,state,inputs,outputs FROM artifact_runs ORDER BY attempt",
    );
    expect(runs.map((r) => [r.attempt, r.state])).toEqual([
      [1, "complete"],
      [2, "failed"], // no input this time: the script can't open inputs/data.csv
    ]);
    expect(JSON.parse(runs[0]?.inputs ?? "[]")).toMatchObject([{ name: "data.csv", bytes: 18 }]);
    expect(JSON.parse(runs[0]?.outputs ?? "[]")).toMatchObject([{ path: "summary.csv" }]);
    expect(
      await query(
        "SELECT COUNT(*) AS n FROM artifact_runs r JOIN artifact_versions v ON v.id=r.version_id",
      ),
    ).toEqual([{ n: 2 }]);
    await themes("attempts");
    writeFileSync(
      join(SHOTS, "result.json"),
      JSON.stringify(
        { schema: 75, attempts: runs.map((r) => [r.attempt, r.state]), printed },
        null,
        1,
      ),
    );
  }, 180000);
});
