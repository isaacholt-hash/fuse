import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { Session, button, byLabel } from "./driver";
const URL = process.env.FUSE_PARALLEL_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const shots = join(import.meta.dirname, "screenshots", "parallel");
let app: Session,
  profile = "";
async function themes(name: string) {
  for (const theme of ["light", "dark"]) {
    await app.run(`document.documentElement.classList.toggle('dark',${String(theme === "dark")});`);
    await new Promise((r) => setTimeout(r, 350));
    expect(await app.run("return document.documentElement.classList.contains('dark');")).toBe(
      theme === "dark",
    );
    await app.screenshot(join(shots, `${name}-${theme}.png`));
  }
}
async function counters() {
  return app.run<{
    children: number;
    complete: number;
    roots: number;
    rootChanges: number;
    changes: number;
    rootSpend: number;
    actualSpend: number;
    unknown: number;
    requests: number;
  }>(
    `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:"SELECT (SELECT COUNT(*) FROM code_children) children,(SELECT COUNT(*) FROM code_children WHERE state='complete') complete,(SELECT COUNT(*) FROM runs WHERE parent_run_id IS NULL) roots,(SELECT COUNT(*) FROM run_changes c JOIN runs r ON r.id=c.run_id WHERE r.parent_run_id IS NULL) rootChanges,(SELECT COUNT(*) FROM run_changes) changes,(SELECT SUM(spent_micro_usd) FROM runs WHERE parent_run_id IS NULL) rootSpend,(SELECT SUM(cost_micro_usd) FROM request_log WHERE purpose='agent') actualSpend,(SELECT COUNT(*) FROM request_log WHERE billing_state='unknown') unknown,(SELECT COUNT(*) FROM request_log WHERE purpose='agent') requests",params:[]})}).then(async r=>{if(!r.ok)throw new Error('fixture counters failed');return(await r.json())[0]});`,
  );
}
describe.skipIf(!URL || !BROWSER)(
  "native child worktrees through shared web and independent HULK owner",
  () => {
    beforeAll(async () => {
      mkdirSync(shots, { recursive: true });
      profile = mkdtempSync(join(tmpdir(), "fuse-parallel-browser-"));
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
      await app.type('(//input[@type="password"])[1]', "a synthetic parallel passphrase");
      await app.type('(//input[@type="password"])[2]', "a synthetic parallel passphrase");
      await app.click(button("Set passphrase"));
      await app.find(byLabel("Message"));
      await app.click('//*[@aria-label="Area"]//button[normalize-space()="Code"]');
      await app.click(button("New session in Parallel fixture"));
      await app.find(byLabel("Project: Parallel fixture"));
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
    test("denial creates no child and exact approved tasks are visible in both themes", async () => {
      await app.type(byLabel("Message"), "Recorded parallel tasks: alpha and beta.");
      await app.press("Enter");
      await app.find('//*[contains(text(),"Start 2 child Code runs at commit")]');
      expect((await counters()).children).toBe(0);
      await app.run(
        "document.querySelector('[aria-label=\"Allow once\"]').scrollIntoView({block:'end'});",
      );
      await themes("approval");
      await app.click(button("Deny"));
      await app.gone(button("Allow once"));
      await app.find('//*[contains(text(),"Parallel work was declined; no child was started.")]');
      expect((await counters()).children).toBe(0);
      for (let i = 0; i < 100; i++) {
        if ((await counters()).requests === 4) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const denied = await app.run<{ content: string; status: string }[]>(
        `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:"SELECT content,status FROM messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1",params:[]})}).then(r=>r.json());`,
      );
      expect(denied[0]).toMatchObject({
        status: "complete",
        content: "Parallel work was declined; no child was started.",
      });
    });
    test("HULK finishes separate children after caller navigation and preserves original parent bytes and totals", async () => {
      await app.type(byLabel("Message"), "Recorded parallel tasks again: alpha and beta.");
      await app.press("Enter");
      await app.find('//*[contains(text(),"Start 2 child Code runs at commit")]');
      await app.click(button("Allow once"));
      await app.find("//*[@data-child-approval]");
      const firstChild = await app.run<string>(
        "return document.querySelector('[data-child-approval]').getAttribute('data-child-approval');",
      );
      expect((await counters()).changes).toBe(0);
      await themes("child-approval");
      await app.click(button("Allow once"));
      await app.find(`//*[@data-child-approval and @data-child-approval!="${firstChild}"]`);
      await app.click(button("Allow once"));
      await app.navigate("about:blank");
      await new Promise((r) => setTimeout(r, 3500));
      await app.navigate(URL);
      await app.find(byLabel("Message"));
      await app.find('//*[contains(text(),"Parallel children finished independently.")]');
      for (let i = 0; i < 100; i++) {
        const c = await counters();
        if (c.complete === 2 && c.unknown === 0 && c.requests === 14) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const result = await counters();
      expect(result).toMatchObject({
        children: 2,
        complete: 2,
        roots: 2,
        rootChanges: 0,
        changes: 2,
        unknown: 0,
        requests: 14,
      });
      expect(result.rootSpend).toBe(result.actualSpend);
      expect(result.actualSpend).toBeGreaterThan(0);
      const paths = await app.run<{ path: string; id: string }[]>(
        `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:'SELECT child_id AS id,path FROM code_children ORDER BY ordinal',params:[]})}).then(r=>r.json());`,
      );
      expect(paths).toHaveLength(2);
      expect(new Set(paths.map((p) => p.path)).size).toBe(2);
      expect(paths.map((p) => readFileSync(join(p.path, "result.txt"), "utf8"))).toEqual([
        "alpha\n",
        "beta\n",
      ]);
      expect(readFileSync(join(process.env.FUSE_PARALLEL_FOLDER ?? "", "notes.txt"), "utf8")).toBe(
        "uncommitted parent\n",
      );
      await app.run(
        "Array.from(document.querySelectorAll('section[aria-label=\"Coding run\"]')).at(-1).scrollIntoView({block:'center'});",
      );
      await themes("completed");
      await app.click(button("Collapse sidebar (Ctrl+B)"));
      await app.resize(390, 844);
      await app.run(
        "Array.from(document.querySelectorAll('section[aria-label=\"Coding run\"]')).at(-1).scrollIntoView({block:'center'});",
      );
      expect(
        await app.run(
          "return document.documentElement.scrollWidth<=document.documentElement.clientWidth;",
        ),
      ).toBe(true);
      await themes("mobile-completed");
      await app.resize(1280, 900);
      writeFileSync(
        join(shots, "result.json"),
        JSON.stringify(
          {
            syntheticModel: true,
            actualNativeWorktrees: true,
            executionOwner: "runner",
            callerNavigatedAway: true,
            liveProviderCalls: 0,
            integrated: false,
            pushed: false,
            parentUnchanged: true,
            ...result,
          },
          null,
          2,
        ),
      );
    });
  },
);
