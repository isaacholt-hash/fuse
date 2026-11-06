// M18.3 provider usage reports in the shared web app, against this build's native server.
// No reporting keys and no provider calls: it checks the native commands and the status view.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Session, button, byLabel } from "./driver";
const URL = process.env.FUSE_REPORTS_WEB_URL ?? "",
  BROWSER = process.env.FUSE_WEB_BROWSER ?? "";
const SHOTS = join(import.meta.dirname, "screenshots", "reports");
let app: Session,
  profile = "";
async function invoke<T>(command: string, args: unknown): Promise<T> {
  return app.run<T>(
    `const r=await fetch('/api/invoke/${command}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(args)})});const body=await r.json();return {ok:r.ok,body};`,
  );
}

describe.skipIf(!URL || !BROWSER)("provider usage reports in the shared web app", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "fuse-reports-web-"));
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
    const pass = "a synthetic usage report passphrase";
    await app.type('(//input[@type="password"])[1]', pass);
    await app.type('(//input[@type="password"])[2]', pass);
    await app.click(button("Set passphrase"));
    await app.find(byLabel("Message"));
  }, 120000);
  afterAll(() => {
    const started = app as Session | undefined;
    if (started) {
      writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
      started.quit();
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  test("off until set up; refresh without a key makes no request; status view in both themes", async () => {
    const migrations = await invoke<{ body: { version: number }[] }>("db_select", {
      sql: "SELECT MAX(version) AS version FROM _sqlx_migrations",
      params: [],
    });
    expect(migrations.body).toEqual([{ version: 78 }]);
    expect(await invoke("report_key_status", { provider: "openai" })).toEqual({
      ok: true,
      body: false,
    });
    const refused = await invoke<{ ok: boolean; body: unknown }>("report_refresh", {
      provider: "anthropic",
    });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused.body)).toContain("Add a reporting key");
    const rows = await invoke<{ body: { n: number }[] }>("db_select", {
      sql: "SELECT (SELECT COUNT(*) FROM usage_report_rows)+(SELECT COUNT(*) FROM usage_report_runs) AS n",
      params: [],
    });
    expect(rows.body).toEqual([{ n: 0 }]);

    await app.run('window.location.hash = "#settings/costs-limits/provider-reports"; return true;');
    await app.find(byLabel("OpenAI admin key"));
    await app.sees("No reporting key.");
    for (const theme of ["light", "dark"]) {
      await app.run(
        `document.documentElement.classList.toggle('dark',${theme === "dark" ? "true" : "false"});`,
      );
      await new Promise((r) => setTimeout(r, 200));
      await app.screenshot(join(SHOTS, `settings-${theme}.png`));
    }
  }, 120000);
});
