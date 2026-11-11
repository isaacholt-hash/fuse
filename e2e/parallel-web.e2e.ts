import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, afterEach, describe, expect, test } from "vitest";
import { Session, button, byLabel } from "./driver";
const URL = process.env.FUSE_PARALLEL_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const shots = join(import.meta.dirname, "screenshots", "parallel");
let app: Session,
  profile = "";
function resultInfo(raw: string): { commit: string; branch: string; path: string } {
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("commit" in value) ||
    typeof value.commit !== "string" ||
    !("branch" in value) ||
    typeof value.branch !== "string" ||
    !("path" in value) ||
    typeof value.path !== "string"
  )
    throw new Error("Malformed native fixture result");
  return { commit: value.commit, branch: value.branch, path: value.path };
}
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
      const build = await app.run<{ schema: number }>(
        "return fetch('/api/invoke/app_build',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json());",
      );
      expect(build.schema, "The fixture must use the freshly built native server").toBe(
        readdirSync(join(import.meta.dirname, "../src-tauri/migrations")).filter((name) =>
          name.endsWith(".sql"),
        ).length,
      );
      await app.click('//*[@aria-label="Area"]//button[normalize-space()="Code"]');
      await app.click(button("New session in Parallel fixture"));
      await app.find(byLabel("Project: Parallel fixture"));
    }, 120000);
    afterEach(async ({ task }) => {
      const started = app as Session | undefined;
      if (task.result?.state === "fail" && started) {
        await started.screenshot(join(shots, "integration-failure.png"));
        writeFileSync(
          join(shots, "integration-failure.txt"),
          await app.run<string>("return document.body.innerText;"),
        );
      }
    });
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
      await app.find('//*[contains(text(),"Start 2 parallel tasks from commit")]');
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
      await app.find('//*[contains(text(),"Start 2 parallel tasks from commit")]');
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
        if (c.complete === 2 && c.unknown === 0 && c.requests === 16) break;
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
        requests: 16,
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
      // The run card renders after the answer settles; wait for it rather than racing it.
      await app.find('//section[@aria-label="Coding run"]', 30_000);
      await app.run(
        "Array.from(document.querySelectorAll('section[aria-label=\"Coding run\"]')).at(-1).scrollIntoView({block:'center'});",
      );
      await themes("completed");
      await app.click(button("Collapse sidebar (Ctrl+B)"));
      await app.resize(390, 844);
      await app.find('//section[@aria-label="Parallel tasks"]', 30_000);
      await app.run(
        "Array.from(document.querySelectorAll('section[aria-label=\"Parallel tasks\"]')).at(-1).scrollIntoView({block:'start'});",
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
    test("reviewed commits and integration require exact approval, preserve conflicts and reject stale parent inputs", async () => {
      const repo = process.env.FUSE_PARALLEL_FOLDER ?? "";
      const parentHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const indexBefore = readFileSync(join(repo, ".git", "index"));
      const notes = join(repo, "notes.txt");
      const originalStat = statSync(notes, { bigint: true });
      const before = await counters();
      await app.find(button("Review changes, task 1"));
      expect(
        await app.run("return document.querySelectorAll('[data-parallel-child] details').length;"),
      ).toBe(2);
      await app.run(
        "document.querySelector('section[aria-label=\"Parallel tasks\"]').scrollIntoView({block:'center'});",
      );
      await themes("progress");
      await app.click(button("Review changes, task 1"));
      await app.find(button("Commit reviewed child"));
      await themes("child-review");
      await app.click(button("Cancel"));
      const countRefs = () =>
        execFileSync(
          "git",
          ["-C", repo, "for-each-ref", "--format=%(objectname)", "refs/heads/fuse/child/"],
          { encoding: "utf8" },
        )
          .trim()
          .split("\n");
      expect(countRefs()).toEqual([parentHead, parentHead]);
      const pins: { childId: string; commit: string }[] = [];
      for (const n of [1, 2]) {
        await app.click(button(`Review changes, child ${String(n)}`));
        await app.find(button("Commit reviewed child"));
        if (n === 1)
          await app.run(`
          const original = window.fetch.bind(window);
          window.fetch = async (input, options) => {
            const response = await original(input, options);
            if (String(input).endsWith('/api/invoke/code_child_apply')) {
              window.fetch = original;
              throw new Error('Recorded lost response after the native commit');
            }
            return response;
          };
        `);
        await app.click(button("Commit reviewed child"));
        await app.sees("Reviewed child commit created.");
        if (n === 1) {
          await app.sees("Completion was confirmed from the execution owner’s retained record");
          await themes("child-recovered-acknowledgement");
        }
        await app.click(button("Done"));
      }
      const rows = await app.run<{ child_id: string; result: string }[]>(
        `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:"SELECT r.child_id,r.result FROM code_child_reviews r JOIN code_children c ON c.child_id=r.child_id WHERE r.kind='child' AND r.state='committed' ORDER BY c.ordinal",params:[]})}).then(r=>r.json());`,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const result = resultInfo(row.result);
        pins.push({ childId: row.child_id, commit: result.commit });
      }
      await app.click(button("Review integration"));
      await app.find(button("Review selected commits"));
      expect(
        await app.run(
          "return document.querySelectorAll('[role=dialog] input[type=checkbox]:checked').length;",
        ),
      ).toBe(0);
      for (const pin of pins) await app.click(byLabel(`Select commit ${pin.commit}`));
      expect(
        await app.run(
          "return document.querySelectorAll('[role=dialog] input[type=checkbox]:checked').length;",
        ),
      ).toBe(2);
      await app.click(button("Review selected commits"));
      await app.sees("Children have conflicting edits in result.txt.");
      await themes("integration-conflict");
      expect(
        execFileSync(
          "git",
          ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/heads/fuse/integration/"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("");
      await app.click(byLabel(`Select commit ${pins[1]?.commit ?? ""}`));
      await app.click(button("Review selected commits"));
      await app.find(button("Approve integration branch"));
      await themes("integration-review");
      writeFileSync(notes, "parent changed after review\n");
      await app.click(button("Approve integration branch"));
      await app.sees("The parent changed since delegation.");
      await themes("integration-stale");
      expect(
        execFileSync(
          "git",
          ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/heads/fuse/integration/"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("");
      // Restore only this throwaway fixture's exact bytes AND nanosecond timestamp. A fresh
      // approval is still required; a stale review is never reused after the refusal.
      writeFileSync(notes, "uncommitted parent\n");
      execFileSync("python3", [
        "-c",
        "import os,sys;os.utime(sys.argv[1],ns=(int(sys.argv[2]),int(sys.argv[3])))",
        notes,
        originalStat.atimeNs.toString(),
        originalStat.mtimeNs.toString(),
      ]);
      await app.click(button("Cancel"));
      await app.click(button("Review integration"));
      await app.find(button("Review selected commits"));
      await app.click(byLabel(`Select commit ${pins[0]?.commit ?? ""}`));
      await app.click(button("Review selected commits"));
      await app.find(button("Approve integration branch"));
      await app.click(button("Approve integration branch"));
      await app.sees("Integration branch is ready for review.");
      await themes("integration-complete");
      await app.resize(390, 844);
      await themes("mobile-integration");
      expect(
        await app.run(
          "return document.documentElement.scrollWidth<=document.documentElement.clientWidth;",
        ),
      ).toBe(true);
      await app.resize(1280, 900);
      const integrations = await app.run<{ result: string }[]>(
        `return fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:"SELECT result FROM code_child_reviews WHERE kind='integration' AND state='complete'",params:[]})}).then(r=>r.json());`,
      );
      expect(integrations).toHaveLength(1);
      const integrated = resultInfo(integrations[0]?.result ?? "{}");
      expect(readFileSync(join(integrated.path, "result.txt"), "utf8")).toBe("alpha\n");
      expect(readFileSync(join(integrated.path, "notes.txt"), "utf8")).toBe("committed base\n");
      const parents = execFileSync(
        "git",
        ["-C", repo, "show", "-s", "--format=%P", integrated.commit],
        { encoding: "utf8" },
      )
        .trim()
        .split(" ");
      expect(parents).toEqual([parentHead, pins[0]?.commit]);
      expect(readFileSync(notes, "utf8")).toBe("uncommitted parent\n");
      expect(readFileSync(join(repo, ".git", "index"))).toEqual(indexBefore);
      expect(
        execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      ).toBe(parentHead);
      expect(await counters()).toEqual(before);
      const old: unknown = JSON.parse(readFileSync(join(shots, "result.json"), "utf8"));
      if (!old || typeof old !== "object" || Array.isArray(old))
        throw new Error("Malformed fixture result");
      writeFileSync(
        join(shots, "result.json"),
        JSON.stringify(
          {
            ...old,
            integrated: true,
            integrationBranch: integrated.branch,
            integrationCommit: integrated.commit,
            approvedChildCommits: [pins[0]?.commit],
            committedChildren: 2,
            conflictPreserved: true,
            staleParentRefused: true,
            cancelCreatesNoCommit: true,
            acknowledgementRecoveredFromJournal: true,
            parentIndexUnchanged: true,
            automaticProviderRequestsAfterReview: 0,
          },
          null,
          2,
        ),
      );
      await app.click(button("Done"));
    }, 120000);
  },
);
