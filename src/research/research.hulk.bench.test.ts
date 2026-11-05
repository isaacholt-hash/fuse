// @vitest-environment node
/** Actual isolated native server and separate Node owner. Synthetic adapters, no live account/key. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultCatalog as catalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createThread } from "@/storage/threads";
import { askToStartWithId, askToContinueResearch, type StartInput } from "@/storage/runQueue";
import { getRun } from "@/storage/runs";
import { listRecentRequests } from "@/storage/requestLog";
import { runExposure } from "@/storage/requestBudget";
import { uuidv7 } from "@/storage/ids";
import type { SqlDb, SqlValue } from "@/storage/sql";
import { researchModels } from "./routing";
import { checkpoint } from "./storage";
import { EMPTY_SELECTION, modelRef } from "./types";
const BIN = process.env.FUSE_SERVER_BIN,
  OUT = process.env.FUSE_RESEARCH_HULK_OUTPUT;
const enabled = Boolean(BIN && OUT && process.platform === "linux");
const PASS = "A synthetic research benchmark passphrase only";
let server: ChildProcess | undefined,
  base = "",
  home = "",
  failed = false;
const log: string[] = [],
  results: Record<string, unknown>[] = [];
async function decoded<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Isolated research fixture HTTP ${String(response.status)}`);
  return response.json() as Promise<T>;
}
async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const port = address.port;
  await new Promise<void>((resolve) =>
    socket.close(() => {
      resolve();
    }),
  );
  return port;
}
async function waitValue<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  ms = 20000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > end) throw new Error("Isolated research fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
class Page {
  constructor(readonly cookie: string) {}
  invoke<T>(name: string, args: Record<string, unknown> = {}) {
    return fetch(`${base}/api/invoke/${name}`, {
      method: "POST",
      headers: { cookie: this.cookie, "content-type": "application/json" },
      body: JSON.stringify(args),
    }).then(decoded<T>);
  }
  readonly db: SqlDb = {
    execute: (sql: string, params: SqlValue[] = []) => this.invoke("db_execute", { sql, params }),
    select: <Row>(sql: string, params: SqlValue[] = []) =>
      this.invoke<Row[]>("db_select", { sql, params }),
    batch: (statements) => this.invoke("db_batch", { statements }),
  };
  async close() {
    const response = await fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie: this.cookie },
    });
    if (!response.ok) throw new Error("Fixture session did not close");
  }
}
async function session(setup = false) {
  const response = await fetch(`${base}/api/auth/${setup ? "set-up" : "sign-in"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  await decoded(response);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Fixture session absent");
  const page = new Page(cookie);
  await page.invoke("db_open");
  return page;
}
async function queued(page: Page, task: string) {
  const thread = await createThread(page.db, tenant, "Research benchmark");
  const models = researchModels(catalog, defaultPolicy, { kind: "auto" }, task, [
    "openai",
    "anthropic",
  ]);
  const id = uuidv7();
  const input: StartInput = {
    threadId: thread.id,
    projectId: null,
    task,
    kind: "research",
    model: modelRef(models.worker),
    planner: modelRef(models.best),
    capMicroUsd: 5_000_000,
    research: { protocol: 1, selection: structuredClone(EMPTY_SELECTION), pinned: false },
  };
  await askToStartWithId(page.db, tenant, id, input);
  return { id, thread, input };
}

describe.skipIf(!enabled)("research on an independent HULK owner", () => {
  beforeAll(async () => {
    mkdirSync(join(homedir(), "scratch"), { recursive: true });
    home = mkdtempSync(join(homedir(), "scratch", "fuse-research-bench-"));
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        "vite.research-fixture.config.ts",
      ],
      { stdio: "pipe" },
    );
    const port = await freePort();
    base = `http://127.0.0.1:${String(port)}`;
    mkdirSync(join(home, "ui"));
    writeFileSync(
      join(home, "ui", "index.html"),
      "<!doctype html><title>Synthetic research fixture</title>",
    );
    server = spawn(
      resolve(BIN ?? ""),
      [
        "--port",
        String(port),
        "--home",
        join(home, "data"),
        "--ui",
        join(home, "ui"),
        "--runner",
        resolve("src-tauri/target/research-runner-fixture/research-fixture.mjs"),
        "--node",
        process.execPath,
        "--test-keys-in-memory",
      ],
      {
        detached: true,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, FUSE_SERVER_TEST: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const keep = (chunk: Buffer) => {
      log.push(chunk.toString());
    };
    server.stdout?.on("data", keep);
    server.stderr?.on("data", keep);
    await waitValue(
      () =>
        fetch(`${base}/api/auth/state`)
          .then((r) => r.ok)
          .catch(() => false),
      (value) => value,
    );
    await session(true);
  }, 60000);
  afterEach((context) => {
    if (context.task.result?.state === "fail") failed = true;
  });
  afterAll(async () => {
    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(join(dirname(OUT), "research-benchmark-server.log"), log.join(""));
      writeFileSync(
        OUT,
        JSON.stringify({ synthetic: true, liveProviderCalls: 0, results }, null, 2) + "\n",
      );
    }
    if (server?.pid) {
      const pid = server.pid;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        /* Fixture already exited. */
      }
      if (server.exitCode === null)
        await Promise.race([
          new Promise<void>((resolve) =>
            server?.once("exit", () => {
              resolve();
            }),
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Its isolated process group is gone. */
      }
    }
    if (home && !failed) rmSync(home, { recursive: true, force: true });
    expect(results).toHaveLength(2);
  }, 15000);
  test("HULK finishes after the caller signs out; duplicate delivery observes one run", async () => {
    const caller = await session();
    const { id, thread, input } = await queued(caller, "Compare recorded tide measurements");
    await waitValue(
      () => getRun(caller.db, tenant, id),
      (run) => Boolean(run),
    );
    await caller.close();
    await expect(caller.db.select("SELECT id FROM runs")).rejects.toThrow("401");
    const observer = await session();
    const done = await waitValue(
      () => getRun(observer.db, tenant, id),
      (run) => run?.status === "done",
    );
    expect(done?.spentMicroUsd).toBe(31000);
    await askToStartWithId(observer.db, tenant, id, input);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const receipts = (await listRecentRequests(observer.db, tenant)).filter(
      (r) => r.threadId === thread.id,
    );
    expect(receipts).toHaveLength(4);
    expect(receipts.reduce((sum, r) => sum + r.usage.costMicroUsd, 0)).toBe(done?.spentMicroUsd);
    expect(
      await observer.db.select("SELECT DISTINCT surface FROM request_log WHERE thread_id=?", [
        thread.id,
      ]),
    ).toEqual([{ surface: "runner" }]);
    expect(await observer.db.select("SELECT id FROM folders")).toEqual([]);
    expect(await observer.db.select("SELECT id FROM run_changes")).toEqual([]);
    results.push({
      scenario: "HULK continues after caller session closes",
      callerSessionClosed: true,
      requests: 4,
      costMicroUsd: done?.spentMicroUsd,
      executionOwner: "runner",
      duplicateExecutions: 0,
      folderGrants: 0,
    });
  }, 30000);
  test("a hard runner exit preserves unknown exposure; restart cannot execute and explicit continuation never replays search", async () => {
    const caller = await session();
    const { id, thread } = await queued(
      caller,
      "FUSE_RESEARCH_CRASH_FIXTURE compare tide measurements",
    );
    const stopped = await waitValue(
      () => getRun(caller.db, tenant, id),
      (run) => run?.status === "stopped",
      30000,
    );
    expect(stopped?.note).toContain("FUSE closed");
    expect(log.join("")).toContain("hard exit after journaled search dispatch");
    let receipts = (await listRecentRequests(caller.db, tenant)).filter(
      (r) => r.threadId === thread.id,
    );
    expect(receipts).toHaveLength(2);
    expect(receipts.filter((r) => r.billingState === "unknown")).toHaveLength(1);
    expect((await runExposure(caller.db, tenant, id)).held).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      (await listRecentRequests(caller.db, tenant)).filter((r) => r.threadId === thread.id),
    ).toHaveLength(2);
    await askToContinueResearch(caller.db, tenant, id, 5_000_000);
    await waitValue(
      () => checkpoint({ db: caller.db, tenant }, id),
      (stored) => stored.state.stage === "finished",
    );
    receipts = (await listRecentRequests(caller.db, tenant)).filter(
      (r) => r.threadId === thread.id,
    );
    expect(receipts).toHaveLength(4);
    expect(receipts.filter((r) => r.billingState === "unknown")).toHaveLength(1);
    expect(
      await caller.db.select(
        "SELECT COUNT(*) n FROM research_operations WHERE run_id=? AND kind='search'",
        [id],
      ),
    ).toEqual([{ n: 1 }]);
    expect((await runExposure(caller.db, tenant, id)).held).toBeGreaterThan(0);
    results.push({
      scenario: "HULK hard owner exit and explicit continuation",
      hardExit: true,
      automaticRequestsAfterRestart: 0,
      searchAttempts: 1,
      replayedSearchAttempts: 0,
      unknownBillingRows: 1,
      heldMicroUsd: (await runExposure(caller.db, tenant, id)).held,
    });
  }, 45000);
});
