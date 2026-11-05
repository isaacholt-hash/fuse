// Shared context tools against this build's native database; scripted responses, no provider keys.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Session, button, byLabel } from "./driver";
const URL = process.env.FUSE_CONTEXT_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "context");
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
}
async function query<T>(sql: string): Promise<T[]> {
  return app.run<T[]>(
    `const r=await fetch('/api/invoke/db_select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql:${JSON.stringify(sql)},params:[]})});if(!r.ok)throw new Error('Fixture query failed');return r.json();`,
  );
}
describe.skipIf(!URL || !BROWSER)("scoped context tools in the shared web app", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-context-web-"));
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
    const pass = "a synthetic context fixture passphrase";
    await app.type('(//input[@type="password"])[1]', pass);
    await app.type('(//input[@type="password"])[2]', pass);
    await app.click(button("Set passphrase"));
    await app.find(byLabel("Message"));
    expect(await app.run("return document.documentElement.dataset.build;")).toBe(
      "fuse-e2e-scripted-build",
    );
    expect(await query("SELECT MAX(version) AS version FROM _sqlx_migrations")).toEqual([
      { version: 73 },
    ]);
    // Assert the new columns/table from the actual native process, never a TS-only mock.
    expect(
      (await query<{ name: string }>("PRAGMA table_info(memory_proposals)")).map((x) => x.name),
    ).toContain("target_revision");
    expect(await query("SELECT * FROM artifact_vectors")).toEqual([]);
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
  test("a tool creates a visible versioned draft and an inert scoped memory suggestion", async () => {
    await app.type(byLabel("Message"), "E2E context draft");
    await app.press("Enter");
    await app.find(byLabel("Artifact: Context brief"));
    await app.find(byLabel("Memory suggestions"));
    expect(await query("SELECT text,status FROM memory_proposals")).toEqual([
      { text: "Prefers concise chapters", status: "pending" },
    ]);
    expect(await query("SELECT COUNT(*) AS n FROM memories")).toEqual([{ n: 0 }]);
    expect(await query("SELECT COUNT(*) AS n FROM runs")).toEqual([{ n: 0 }]);
    expect(await query("SELECT COUNT(*) AS n FROM artifact_versions")).toEqual([{ n: 1 }]);
    await themes("created-artifact");
    await app.click(byLabel("Close artifact"));
    await app.click('//*[@aria-label="Memory suggestions"]//button[normalize-space()="Review"]');
    await app.find('//*[@role="dialog"]//textarea[@aria-label="Suggested memory"]');
    await app.sees("only in its conversation");
    await app.sees("suggested by anthropic/");
    await themes("memory-review");
    await app.click('//*[@role="dialog"]//button[normalize-space()="Keep"]');
    await app.find('//*[@role="dialog"]//*[contains(.,"No suggestions waiting.")]');
    expect(
      await query<{ scope: string; authority: string }>("SELECT scope,authority FROM memories"),
    ).toEqual([{ scope: "conversation", authority: "extracted" }]);
    await app.press("Escape");
  });
  test("the saved artifact reopens, an owner edit creates another version, and keyword retrieval records source UUIDs", async () => {
    await app.click(byLabel("Open Context brief"));
    await app.find(byLabel("Artifact: Context brief"));
    await app.click(byLabel("Edit artifact"));
    await app.type(
      byLabel("Artifact content"),
      "# Quiet roads\n\nAn owner revision about electric cars.",
      true,
    );
    await app.click(button("Save as a new version"));
    await app.find(byLabel("Version"));
    expect(
      await app.run(
        `const panel=document.querySelector('[aria-label="Artifact: Context brief"]');const close=panel.querySelector('[aria-label="Close artifact"]').getBoundingClientRect();const title=panel.querySelector('span.block.truncate').getBoundingClientRect();return close.right<=panel.getBoundingClientRect().right && title.width>=80;`,
      ),
    ).toBe(true);
    await themes("owner-version");
    await app.click(byLabel("Close artifact"));
    await app.type(byLabel("Message"), "E2E context search");
    await app.press("Enter");
    await app.sees("Found the saved Context brief by keyword.");
    await themes("keyword-source");
    const versions = await query<{ id: string; content: string; source: string }>(
      "SELECT id,content,source FROM artifact_versions ORDER BY version,id",
    );
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      content: "# Quiet roads\n\nAn owner revision about electric cars.",
      source: "user",
    });
    expect(await app.run("return document.body.textContent;")).toContain(versions[1]?.id);
    const counts = (
      await query<{ requests: number; runs: number; folders: number; unknown: number }>(
        "SELECT (SELECT COUNT(*) FROM request_log) requests,(SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM folders) folders,(SELECT COUNT(*) FROM request_log WHERE billing_state='unknown') unknown",
      )
    )[0];
    expect(counts).toMatchObject({ runs: 0, folders: 0, unknown: 0 });
    const audit = await query(
      "SELECT tool_name,outcome FROM context_tool_audit ORDER BY created_at,id",
    );
    expect(audit).toContainEqual({ tool_name: "propose_memory", outcome: "proposed" });
    expect(audit).toContainEqual({ tool_name: "create_artifact", outcome: "created" });
    expect(audit).toContainEqual({ tool_name: "search_artifacts", outcome: "read" });
    writeFileSync(
      join(SHOTS, "result.json"),
      JSON.stringify(
        {
          synthetic: true,
          liveProviderCalls: 0,
          actualNativeDatabase: true,
          memoryOwnerReviewed: true,
          artifactVersions: versions.length,
          counts,
          audit,
          themes: ["light", "dark"],
        },
        null,
        2,
      ) + "\n",
    );
  });
});
