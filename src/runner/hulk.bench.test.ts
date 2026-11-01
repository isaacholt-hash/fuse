// @vitest-environment node
// M10 step 10, part 1: the recorded runs-on-HULK benchmark. A throwaway fuse-server (its keys in
// memory, `--test-keys-in-memory`), a "page" that is plain fetch calls with a session cookie, and
// the runner in this process going through the server's commands like the real one, with only
// the model scripted (the real Anthropic adapter over recorded-style turns, so no key). `pnpm
// hulk:bench` builds the server and runs it; skipped unless FUSE_SERVER_BIN is set.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RunDeps } from "@/agent/run";
import { nodeGit } from "@/agent/testing/bench";
import { anthropicTurn, type Turn } from "@/agent/testing/turns";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { tauriFilesApi, type FilesApi } from "@/files/api";
import type { HulkApi } from "@/handover/api";
import { handOver } from "@/handover/handover";
import { tauriMcpApi } from "@/mcp/api";
import { configureHttp } from "@/platform/http";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import type { FetchLike } from "@/providers/types";
import { tauriRepo } from "@/repo/api";
import { tauriExec } from "@/repo/exec";
import { tauriGit } from "@/repo/git";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { grantFolder, linkProjectFolder, linkThreadFolder } from "@/storage/folders";
import { listProjectMcpServers } from "@/storage/mcp";
import { createProject } from "@/storage/projects";
import {
  answerApproval,
  askToContinue,
  askToStart,
  getRequest,
  openApprovals,
} from "@/storage/runQueue";
import { getRun, listSteps, type RunMode } from "@/storage/runs";
import type { SqlDb, SqlValue } from "@/storage/sql";
import { openTauriDb } from "@/storage/tauriDb";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { tauriWebApi } from "@/web/api";
import { Runner } from "./runner";

const BIN = process.env.FUSE_SERVER_BIN;
const t = DEFAULT_TENANT;
const PASS = "a long throwaway passphrase";
const model = defaultCatalog.models.find((m) => m.provider === "anthropic");
if (!model) throw new Error("no Anthropic model in the catalog");
const ref = { provider: model.provider, id: model.id };

/** Everything the benchmark makes on disk, under $HOME (the server's repo_check wants that). */
const ROOT = join(homedir(), `.fuse-hulk-bench-${String(process.pid)}`);

// --- The model: each scenario's turns, picked from the request (its task's tag, its turn). ---

type Step = Turn | ((signal: AbortSignal | undefined) => Promise<Turn>);
const DONE: Turn = { text: "Done." };
const scripts: Record<string, Step[]> = {
  a: [{ calls: [{ name: "read_file", input: { path: "notes.txt", offset: null } }] }, DONE],
  b: [{ calls: [{ name: "write_file", input: { path: "hello.txt", content: "hi\n" } }] }, DONE],
  c: [
    { calls: [{ name: "write_file", input: { path: "FOOTER.md", content: "Made on HULK.\n" } }] },
    DONE,
  ],
  e: [{ calls: [{ name: "list_files", input: { path: "", recursive: false } }] }],
};

/** (e): turn 2 waits until it's let go, or the run is stopped. */
const gate = { asked: 0, release: () => {}, released: new Promise<void>(() => {}) };
gate.released = new Promise<void>((r) => {
  gate.release = r;
});
scripts.e?.push(
  (signal) =>
    new Promise<Turn>((resolve, reject) => {
      gate.asked++;
      const stop = () => {
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) stop();
      signal?.addEventListener("abort", stop, { once: true });
      void gate.released.then(() => {
        signal?.removeEventListener("abort", stop);
        resolve(DONE);
      });
    }),
);

interface Body {
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
}

const userText = (body: Body) =>
  body.messages
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      typeof m.content === "string" ? [m.content] : m.content.map((b) => b.text ?? ""),
    )
    .join("\n");

let turns = 0;
const scripted: FetchLike = async (url, init) => {
  if (!url.endsWith("/v1/messages")) return new Response("{}", { status: 404 });
  const body = JSON.parse(init.body ?? "{}") as Body;
  const tag = /\[bench (\w)\]/.exec(userText(body))?.[1] ?? "";
  const step = scripts[tag]?.[body.messages.filter((m) => m.role === "assistant").length];
  const turn: Turn = !step
    ? { text: `Nothing scripted for ${tag || "this request"}.` }
    : typeof step === "function"
      ? await step(init.signal)
      : step;
  return new Response(anthropicTurn(turn, ++turns), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

// --- The server, the page and the runner. ---

let server: ChildProcess | null = null;
let base = "";
const serverLog: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => {
        resolve(port);
      });
    });
  });
}

async function startServer(bin: string): Promise<string> {
  const port = await freePort();
  const ui = join(ROOT, "ui");
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>FUSE</title>");
  const child = spawn(
    bin,
    ["--port", String(port), "--home", join(ROOT, "server"), "--ui", ui, "--test-keys-in-memory"],
    { env: { ...process.env, FUSE_SERVER_TEST: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  server = child;
  return new Promise((resolve, reject) => {
    const seen = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        serverLog.push(line);
        const m = /on (http:\/\/\S+)/.exec(line);
        if (m?.[1]) resolve(m[1]);
      }
    };
    child.stdout.on("data", seen);
    child.stderr.on("data", seen);
    child.once("exit", (code) => {
      reject(new Error(`fuse-server exited (${String(code)}):\n${serverLog.join("\n")}`));
    });
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly error: unknown,
  ) {
    super(`${String(status)}: ${JSON.stringify(error)}`);
  }
}

async function reply<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = data && typeof data === "object" && "error" in data ? data.error : data;
    throw new HttpError(res.status, error);
  }
  return data as T;
}

const post = (path: string, headers: Record<string, string>, body: string | Uint8Array) =>
  // A copy of bytes, so the body is a plain ArrayBuffer-backed view fetch accepts.
  fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : new Uint8Array(body),
  });

/** A browser page: its session cookie, and the app's commands and database through it. */
class Page {
  readonly client = randomUUID();
  constructor(readonly cookie: string) {}

  invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return post(
      `/api/invoke/${command}`,
      { cookie: this.cookie, "x-fuse-client": this.client, "content-type": "application/json" },
      JSON.stringify(args),
    ).then((r) => reply<T>(r));
  }

  readonly db: SqlDb = {
    execute: (sql: string, params: SqlValue[] = []) =>
      this.invoke<{ rowsAffected: number }>("db_execute", { sql, params }),
    select: <Row>(sql: string, params: SqlValue[] = []) =>
      this.invoke<Row[]>("db_select", { sql, params }),
  };

  auth<T>(path: string): Promise<T> {
    return post(`/api/auth/${path}`, { cookie: this.cookie }, "").then((r) => reply<T>(r));
  }
}

async function session(path: "set-up" | "sign-in"): Promise<Page> {
  const res = await post(
    `/api/auth/${path}`,
    { "content-type": "application/json" },
    JSON.stringify({ passphrase: PASS }),
  );
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  await reply(res);
  expect(cookie).toMatch(/^fuse_session=./);
  const page = new Page(cookie);
  await page.invoke("db_open");
  return page;
}
const signIn = () => session("sign-in");

/** A device paired from `page`: its token. */
async function pair(page: Page, name: string): Promise<string> {
  const { code } = await page.auth<{ code: string }>("pair-code");
  const res = await post(
    "/api/auth/pair",
    { "content-type": "application/json" },
    JSON.stringify({ code, name }),
  );
  return (await reply<{ token: string }>(res)).token;
}

/** The runner's deps, as src/runner/main.ts builds them, but with the model scripted. */
function runnerDeps(db: SqlDb): () => Promise<RunDeps> {
  const anthropic = createAnthropicAdapter({ fetch: scripted });
  return () =>
    Promise.resolve({
      db,
      tenant: t,
      catalog: defaultCatalog,
      adapterFor: (p) => {
        if (p !== "anthropic") throw new Error(`${p} isn't scripted in the benchmark.`);
        return anthropic;
      },
      files: tauriFilesApi,
      repo: tauriRepo,
      exec: tauriExec,
      git: tauriGit,
      web: tauriWebApi,
      // Python needs the sandbox, which the benchmark doesn't depend on.
      pythonReady: () => Promise.resolve(false),
      mcp: {
        forProject: (pid: string) =>
          listProjectMcpServers(db, t, pid).then((l) => l.map((s) => ({ id: s.id, name: s.name }))),
        tools: (id: string) => tauriMcpApi.tools?.(id) ?? Promise.resolve([]),
        call: (id: string, name: string, args: Record<string, unknown>) =>
          tauriMcpApi.call
            ? tauriMcpApi.call(id, name, args)
            : Promise.reject(new Error("MCP calls aren't available here.")),
      },
    });
}

let runnerDb: SqlDb;
const runnerLog: string[] = [];
const newRunner = () =>
  new Runner({
    deps: runnerDeps(runnerDb),
    pollMs: 50,
    log: (l) => runnerLog.push(l),
  });

async function until(what: string, check: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}\nrunner: ${runnerLog.join("\n")}`);
}

/** A folder on HULK with a note in it, and a chat linked to it, made from `page`. */
async function chatInFolder(page: Page, name: string) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.txt"), "Remember the milk.\n");
  const info = await page.invoke<{ root: string }>("repo_check", { path: dir });
  const folder = await grantFolder(page.db, t, info.root);
  const thread = await createThread(page.db, t, `Bench ${name}`);
  await linkThreadFolder(page.db, t, thread.id, folder.id);
  return { dir: info.root, threadId: thread.id };
}

const start = (page: Page, threadId: string, tag: string, task: string, mode: RunMode) =>
  askToStart(page.db, t, {
    threadId,
    projectId: null,
    task: `[bench ${tag}] ${task}`,
    model: ref,
    mode,
  });

async function runOf(page: Page, requestId: string) {
  const req = await getRequest(page.db, t, requestId);
  expect(req?.status).toBe("done");
  const run = await getRun(page.db, t, req?.runId ?? "");
  if (!run) throw new Error(`no run for request ${requestId}`);
  return run;
}

async function answer(page: Page, messageId: string | null) {
  const rows = await page.db.select<{ content: string; status: string }>(
    "SELECT content, status FROM messages WHERE workspace_id = ? AND id = ?",
    [t.workspaceId, messageId ?? ""],
  );
  return rows[0];
}

const waitingOn = async (page: Page, kind: string) =>
  (await openApprovals<{ kind: string }>(page.db, t)).filter((q) => q.request.kind === kind);

const git = (args: string[], cwd?: string) =>
  execFileSync(
    "git",
    ["-c", "user.name=FUSE bench", "-c", "user.email=bench@fuse.invalid", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();

describe.skipIf(!BIN)("runs on HULK (M10 step 10)", () => {
  let first: Page;
  let runner: Runner;

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    base = await startServer(resolve(BIN ?? ""));
    first = await session("set-up");
    // The runner: a device of its own, and everything over HTTP to the server.
    configureHttp({ base, token: await pair(first, "runner (bench)") });
    runnerDb = await openTauriDb();
    runner = newRunner();
    await runner.recover();
  }, 60_000);

  afterAll(async () => {
    // Whatever a failed scenario left going ends before the server does.
    runner.stopAll();
    await runner.idle();
    const child = server;
    if (child?.pid) {
      const exited = new Promise((r) => child.once("exit", r));
      process.kill(child.pid, "SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    }
    rmSync(ROOT, { recursive: true, force: true });
  }, 20_000);

  it("(a) a run carries on after its browser session closes", async () => {
    const { threadId } = await chatInFolder(first, "a");
    const requestId = await start(first, threadId, "a", "What's in notes.txt?", "ask");

    // The tab is closed and signed out: that cookie is dead.
    await first.auth("sign-out");
    await expect(first.invoke("key_status", { provider: "openai" })).rejects.toMatchObject({
      status: 401,
      error: "signed_out",
    });

    await runner.tick();
    await runner.idle();

    // Later, from a new sign-in: the run finished on its own.
    const later = await signIn();
    const run = await runOf(later, requestId);
    expect(run.status).toBe("done");
    expect(await getRequest(later.db, t, requestId)).toMatchObject({
      status: "done",
      runId: run.id,
    });
    expect(await answer(later, run.messageId)).toEqual({ content: "Done.", status: "complete" });
    const steps = await listSteps(later.db, t, run.id);
    expect(steps.find((s) => s.kind === "tool")?.output).toContain("Remember the milk.");
  }, 60_000);

  it("(b) an approval is answered from a second session", async () => {
    const page = await signIn();
    const { dir, threadId } = await chatInFolder(page, "b");
    const requestId = await start(page, threadId, "b", "Write hello.txt.", "ask");
    await runner.tick();

    // Edits ask in "ask" mode: the run waits for you.
    await until("the edit's question", async () => (await waitingOn(page, "edit")).length === 1);
    expect((await runOf(page, requestId)).status).toBe("running");

    // Another browser signs in and answers it.
    const second = await signIn();
    expect(second.cookie).not.toBe(page.cookie);
    const [question] = await waitingOn(second, "edit");
    expect(await answerApproval(second.db, t, question?.id ?? "", "yes")).toBe(true);
    await runner.idle();

    const run = await runOf(page, requestId);
    expect(run.status).toBe("done");
    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("hi\n");
    expect(await openApprovals(page.db, t)).toEqual([]);
  }, 60_000);

  it("(c) a Code run handed over from a desktop pushes fuse/<id> to its remote", async () => {
    const page = await signIn();
    // A remote with one commit on main, and the desktop's clone of it.
    const bare = join(ROOT, "origin.git");
    const desk = join(ROOT, "desktop-clone");
    git(["init", "-q", "--bare", "--initial-branch=main", bare]);
    git(["clone", "-q", bare, desk]);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], desk);
    writeFileSync(join(desk, "README.md"), "# Site\n");
    git(["add", "README.md"], desk);
    git(["commit", "-q", "-m", "First"], desk);
    git(["push", "-q", "-u", "origin", "main"], desk);

    // The desktop: its own database with the project, and HULK over HTTP with its device token.
    const desktop = openTestDb();
    const project = await createProject(desktop, t, "Site");
    const folder = await grantFolder(desktop, t, desk);
    await linkProjectFolder(desktop, t, project.id, folder.id);
    const token = await pair(page, "TCHALLA (bench)");
    const bearer = { authorization: `Bearer ${token}` };
    const hulk: HulkApi = {
      status: () => Promise.resolve({ address: base, paired: true }),
      pair: () => Promise.reject(new Error("already paired")),
      unpair: () => Promise.reject(new Error("not in the benchmark")),
      invoke: <T>(command: string, args: Record<string, unknown> = {}) =>
        post(
          `/api/invoke/${command}`,
          { ...bearer, "content-type": "application/json" },
          JSON.stringify(args),
        ).then((r) => reply<T>(r)),
      putFile: (bytes) =>
        post(
          "/api/invoke/file_put",
          { ...bearer, "content-type": "application/octet-stream" },
          bytes,
        ).then((r) => reply<{ sha256: string; size: number }>(r)),
    };
    const requestId = await handOver(
      { db: desktop, tenant: t, files: memoryFiles(), git: nodeGit(desk), hulk },
      {
        projectId: project.id,
        folderId: folder.id,
        task: "[bench c] Add a footer note.",
        model: ref,
        mode: "auto_edit",
      },
    );

    await runner.tick();
    // Done on its branch, it asks to push (a send); answered from the page.
    await until("the push question", async () => {
      if ((await waitingOn(page, "git")).length === 1) return true;
      const req = await getRequest(page.db, t, requestId);
      const run = req?.runId ? await getRun(page.db, t, req.runId) : null;
      if (req?.status === "failed" || run?.status === "error" || run?.status === "stopped")
        throw new Error(`No push question: ${JSON.stringify({ req, run })}`);
      return false;
    });
    const [push] = await waitingOn(page, "git");
    await answerApproval(page.db, t, push?.id ?? "", "yes");
    await runner.idle();

    const run = await runOf(page, requestId);
    expect(run.status).toBe("done");
    expect(run.branch).toMatch(/^fuse\//);
    expect(git(["--git-dir", bare, "branch", "--list", "fuse/*"])).toBe(run.branch);
    expect(run.note).toBe(`Pushed ${run.branch ?? ""} to ${bare}.`);
    // The project came over with its id, and the run worked in HULK's own copy.
    const projects = await page.db.select<{ name: string }>(
      "SELECT name FROM projects WHERE workspace_id = ? AND id = ?",
      [t.workspaceId, project.id],
    );
    expect(projects).toEqual([{ name: "Site" }]);
  }, 120_000);

  it.todo("(d) a scheduled task fires on the fake clock (needs step 9)");

  it("(e) Interrupt and Continue", async () => {
    const page = await signIn();
    const { threadId } = await chatInFolder(page, "e");
    const requestId = await start(page, threadId, "e", "List the folder.", "ask");
    const before = newRunner();
    await before.tick();

    // After its first step, the runner stops (as when the server restarts).
    await until("turn 2", () => Promise.resolve(gate.asked === 1));
    const { id: runId } = await runOf(page, requestId);
    const firstSteps = await listSteps(page.db, t, runId);
    expect(firstSteps.map((s) => s.kind)).toEqual(["model", "tool"]);
    before.stopAll();
    await before.idle();
    const stopped = await getRun(page.db, t, runId);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.note).toBe("Stopped.");

    // A new runner, as after a restart; Continue from the page picks the run up.
    const after = newRunner();
    await after.recover();
    await askToContinue(page.db, t, runId);
    gate.release();
    await after.tick();
    await after.idle();

    const run = await getRun(page.db, t, runId);
    expect(run?.status).toBe("done");
    const steps = await listSteps(page.db, t, runId);
    expect(steps.map((s) => s.kind)).toEqual(["model", "tool", "model"]);
    expect(steps.slice(0, 2).map((s) => s.id)).toEqual(firstSteps.map((s) => s.id));
    const last = steps[2];
    expect(last?.kind === "model" ? last.text : null).toBe("Done.");
    expect(await answer(page, run?.messageId ?? null)).toEqual({
      content: "Done.",
      status: "complete",
    });
  }, 60_000);
});

/** The desktop's file store, for the export a handover uploads. */
function memoryFiles(): FilesApi {
  const store = new Map<string, Uint8Array>();
  return {
    put: (bytes) => {
      const sha256 = `sha-${String(store.size)}`;
      store.set(sha256, bytes);
      return Promise.resolve({ sha256, size: bytes.length });
    },
    get: (sha) => {
      const b = store.get(sha);
      return b ? Promise.resolve(b) : Promise.reject(new Error(`no file ${sha}`));
    },
  };
}
