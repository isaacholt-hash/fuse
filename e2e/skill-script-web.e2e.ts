// Native encrypted storage, actual isolated Python, normal background owner; no provider calls.
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { Session, button, byLabel } from "./driver";
const URL = process.env.FUSE_SKILL_SCRIPT_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const shots = join(import.meta.dirname, "screenshots", "skill-scripts");
let app: Session,
  profile = "";
async function themes(name: string) {
  for (const theme of ["light", "dark"]) {
    await app.run(
      `document.documentElement.classList.toggle('dark',${theme === "dark" ? "true" : "false"});`,
    );
    await new Promise((r) => setTimeout(r, 350));
    expect(await app.run("return document.documentElement.classList.contains('dark');")).toBe(
      theme === "dark",
    );
    await app.screenshot(join(shots, `${name}-${theme}.png`));
  }
}
async function counts() {
  return app.run<{
    claims: number;
    completed: number;
    changes: number;
    requests: number;
    unknown: number;
  }>(
    `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:"SELECT (SELECT COUNT(*) FROM skill_script_claims) claims,(SELECT COUNT(*) FROM skill_script_claims WHERE state='complete' AND exit_code=0) completed,(SELECT COUNT(*) FROM run_changes) changes,(SELECT COUNT(*) FROM request_log) requests,(SELECT COUNT(*) FROM request_log WHERE billing_state='unknown') unknown",params:[]})}).then(async r=>{if(!r.ok)throw new Error('fixture query failed');return(await r.json())[0]});`,
  );
}
describe.skipIf(!URL || !BROWSER)(
  "approved skill script through shared web and native execution",
  () => {
    beforeAll(async () => {
      mkdirSync(shots, { recursive: true });
      profile = mkdtempSync(join(tmpdir(), "fuse-script-web-"));
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
      await app.type('(//input[@type="password"])[1]', "a synthetic skill fixture passphrase");
      await app.type('(//input[@type="password"])[2]', "a synthetic skill fixture passphrase");
      await app.click(button("Set passphrase"));
      await app.find(byLabel("Message"));
      await app.click('//*[@aria-label="Area"]//button[normalize-space()="Code"]');
      await app.click(button("New session in Skill script fixture"));
      await app.find(byLabel("Project: Skill script fixture"));
    }, 120000);
    afterAll(() => {
      const started = app as Session | undefined;
      if (started) {
        writeFileSync(join(shots, "console.log"), started.console.join("\n"));
        started.quit();
      }
      if (profile)
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    });
    test("denial executes nothing; exact approval returns native outputs once and changes no project files", async () => {
      const pin = await app.run<string>("return localStorage.getItem('fuse.e2e.skillPin');");
      await app.type(byLabel("Message"), `${pin}\nRun the selected calculation.`);
      await app.press("Enter");
      await app.find('//*[contains(text(),"Run calculate / scripts/calculate.py?")]');
      expect((await counts()).claims).toBe(0);
      await app.run(
        `document.querySelector('[aria-label="Allow once"]').scrollIntoView({block:"end"});`,
      );
      await themes("approval");
      await app.click(button("Deny"));
      await app.gone(button("Allow once"));
      expect((await counts()).claims).toBe(0);
      await app.find('//*[contains(text(),"Skill was declined; nothing ran.")]');
      await app.type(byLabel("Message"), `${pin}\nRun the selected calculation again.`);
      await app.press("Enter");
      await app.find('//*[contains(text(),"Run calculate / scripts/calculate.py?")]');
      await app.click(button("Allow once"));
      await app.gone(button("Allow once"));
      for (let n = 0; n < 120; n++) {
        if ((await counts()).completed === 1) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await app.find('//*[contains(text(),"Approved skill completed in isolated Python")]');
      for (let n = 0; n < 100; n++) {
        if ((await counts()).unknown === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const result = await counts();
      if (result.unknown) {
        const details = await app.run(
          `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:"SELECT purpose,model,billing_state,error_code,error_message FROM request_log WHERE billing_state='unknown'",params:[]})}).then(r=>r.json());`,
        );
        writeFileSync(join(shots, "unresolved-fixture.json"), JSON.stringify(details, null, 2));
      }
      expect(result.claims).toBe(1);
      expect(result.completed).toBe(1);
      expect(result.changes).toBe(0);
      expect(result.unknown).toBe(0);
      await themes("completed");
      await app.click(button("Collapse sidebar (Ctrl+B)"));
      await app.resize(390, 844);
      await app.run(
        `Array.from(document.querySelectorAll('section[aria-label="Coding run"]')).at(-1).scrollIntoView({block:"center"});`,
      );
      await new Promise((r) => setTimeout(r, 250));
      await themes("mobile-completed");
      writeFileSync(
        join(shots, "result.json"),
        JSON.stringify(
          {
            syntheticModel: true,
            systemPythonFixture: true,
            actualNativeIsolation: true,
            liveProviderCalls: 0,
            ...result,
          },
          null,
          2,
        ),
      );
    });

    test("explicit output mapping saves only the approved file and existing Undo restores the folder", async () => {
      const folder = process.env.FUSE_SKILL_SCRIPT_FOLDER;
      if (!folder) throw new Error("Run the isolated skill-script web workflow.");
      await app.resize(1280, 900);
      const pin = await app.run<string>("return localStorage.getItem('fuse.e2e.skillPin');");
      await app.type(byLabel("Message"), `${pin}\nSave output from the selected script.`);
      await app.press("Enter");
      await app.find('//p[contains(normalize-space(),"result.txt → kept-result.txt")]');
      expect(existsSync(join(folder, "kept-result.txt"))).toBe(false);
      await app.run(
        `document.querySelector('[aria-label="Allow once"]').scrollIntoView({block:"end"});`,
      );
      await themes("output-approval");
      await app.click(button("Allow once"));
      await app.gone(button("Allow once"));
      await app.find(button("Undo"));
      expect(readFileSync(join(folder, "kept-result.txt"), "utf8")).toBe("42");
      await themes("saved-output");
      await app.click(button("Undo"));
      await app.find('//*[normalize-space()="Undone"]');
      expect(existsSync(join(folder, "kept-result.txt"))).toBe(false);
      const result = await counts();
      expect(result.claims).toBe(2);
      expect(result.completed).toBe(2);
      expect(result.changes).toBe(1);
      expect(result.unknown).toBe(0);
      writeFileSync(
        join(shots, "saved-output-result.json"),
        JSON.stringify(
          {
            syntheticModel: true,
            actualNativeIsolation: true,
            output: "kept-result.txt",
            restoredEmptyFolder: true,
            ...result,
          },
          null,
          2,
        ),
      );
    });
  },
);
