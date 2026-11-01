// @vitest-environment node
import type { startChatRun } from "@/agent/chatRun";
import type { RunDeps } from "@/agent/run";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { exportData } from "@/data/exportAll";
import type { FilesApi } from "@/files/api";
import type { GitApi } from "@/repo/git";
import { Runner } from "@/runner/runner";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, getProject } from "@/storage/projects";
import { answerApproval, askToStart, getRequest, openApprovals } from "@/storage/runQueue";
import { createRun, getRun, setRunBranch, setRunStatus, type Run } from "@/storage/runs";
import type { SqlDb } from "@/storage/sql";
import { openTestDb } from "@/storage/testing/nodeDb";
import { getThread } from "@/storage/threads";
import { repoOrigin } from "./handover";

const t = DEFAULT_TENANT;
const model =
  defaultCatalog.models.find((m) => m.provider === "anthropic") ?? defaultCatalog.models[0];
if (!model) throw new Error("no model in the catalog");
const ref = { provider: model.provider, id: model.id };

function memoryFiles(): FilesApi & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
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

/** A git that answers from a table and records what it ran. */
function fakeGit(answers: Record<string, { output: string; exitCode: number }> = {}) {
  const ran: { folderId: string; args: string[] }[] = [];
  const git: GitApi = {
    run: (folderId, _program, args) => {
      ran.push({ folderId, args });
      return Promise.resolve(answers[args.join(" ")] ?? { output: "", exitCode: 0 });
    },
  };
  return { git, ran };
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

/** HULK's copy after a run that wrote FOOTER.md and didn't commit it. */
const changed = {
  "status --porcelain": { output: "?? FOOTER.md\n", exitCode: 0 },
  "rev-parse HEAD": { output: "aaa\n", exitCode: 0 },
  "rev-parse origin/main": { output: "aaa\n", exitCode: 0 },
};
const looked = [
  ["status", "--porcelain"],
  ["rev-parse", "HEAD"],
  ["rev-parse", "origin/main"],
];

/** A run that makes its branch and finishes. */
const branchRun: typeof startChatRun = async (deps, input) => {
  const run = await createRun(deps.db, deps.tenant, {
    projectId: input.projectId,
    threadId: input.threadId,
    messageId: null,
    task: input.task,
    provider: input.model.provider,
    model: input.model.id,
    capMicroUsd: 1_000_000,
    kind: "code",
    mode: input.mode ?? "ask",
  });
  input.onProgress?.("answer", { run, steps: [], changes: [], streaming: "" });
  await setRunBranch(deps.db, deps.tenant, run.id, "fuse/fix-the-footer-1");
  await setRunStatus(deps.db, deps.tenant, run.id, "done");
  return (await getRun(deps.db, deps.tenant, run.id)) as Run;
};

async function handedOver(serverDb: SqlDb, files: ReturnType<typeof memoryFiles>) {
  // The desktop: a project, exported the way a handover sends it.
  const desktop = openTestDb();
  const project = await createProject(desktop, t, "Site");
  const { bytes } = await exportData(desktop, t, memoryFiles(), {
    kind: "project",
    projectId: project.id,
  });
  const { sha256 } = await files.put(bytes);
  const requestId = await askToStart(serverDb, t, {
    threadId: null,
    projectId: project.id,
    task: "Fix the footer",
    model: ref,
    mode: "ask",
    kind: "code",
    newBranch: true,
    handover: { exportSha: sha256, remote: "git@github.com:o/site.git", branch: "main" },
  });
  return { project, requestId };
}

test("a handed-over run: the project comes over, the run works in HULK's clone, and asks to push", async () => {
  const db = openTestDb();
  const files = memoryFiles();
  const { git, ran } = fakeGit(changed);
  const cloned: string[] = [];
  const runner = new Runner({
    deps: () =>
      Promise.resolve({
        db,
        tenant: t,
        catalog: defaultCatalog,
        adapterFor: () => {
          throw new Error("no provider");
        },
        repo: {} as RunDeps["repo"],
        files,
        git,
      }),
    start: branchRun,
    clone: (remote, branch) => {
      cloned.push(`${remote} ${branch}`);
      return Promise.resolve("/home/daywalker/.local/share/fuse-server/data/work/site-1234");
    },
    pollMs: 1,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  const { project, requestId } = await handedOver(db, files);
  await runner.tick();

  expect(cloned).toEqual(["git@github.com:o/site.git main"]);
  expect((await getProject(db, t, project.id))?.name).toBe("Site");
  const req = await getRequest(db, t, requestId);
  const run = await getRun(db, t, req?.runId ?? "");
  const thread = await getThread(db, t, run?.threadId ?? "");
  expect(thread?.title).toBe("Fix the footer (from the desktop)");
  expect(thread?.projectId).toBe(project.id);
  const folders = await db.select<{ path: string }>(
    `SELECT f.path FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id WHERE tf.thread_id = ?`,
    [thread?.id ?? ""],
  );
  expect(folders.map((f) => f.path)).toEqual([
    "/home/daywalker/.local/share/fuse-server/data/work/site-1234",
  ]);

  // Committing and pushing is a send: it waits for you (having only looked), then commits what
  // the run changed and pushes only the run's branch.
  await until(async () => (await openApprovals(db, t)).length === 1);
  const [q] = await openApprovals<{ kind: string; summary: string; remote: boolean }>(db, t);
  expect(q?.request).toMatchObject({
    kind: "git",
    summary: "Commit and push fuse/fix-the-footer-1 to git@github.com:o/site.git",
    remote: true,
  });
  expect(ran.map((r) => r.args)).toEqual(looked);
  await answerApproval(db, t, q?.id ?? "", "yes");
  await runner.idle();
  expect(ran.map((r) => r.args)).toEqual([
    ...looked,
    ["add", "-A"],
    ["commit", "-m", "Fix the footer"],
    ["push", "-u", "origin", "fuse/fix-the-footer-1"],
  ]);
  expect(await getRun(db, t, run?.id ?? "")).toMatchObject({
    status: "done",
    note: "Pushed fuse/fix-the-footer-1 to git@github.com:o/site.git.",
  });
});

test("saying no to the push leaves the branch on HULK's copy, and says so", async () => {
  const db = openTestDb();
  const files = memoryFiles();
  const { git, ran } = fakeGit(changed);
  const runner = new Runner({
    deps: () =>
      Promise.resolve({
        db,
        tenant: t,
        catalog: defaultCatalog,
        adapterFor: () => {
          throw new Error("no provider");
        },
        repo: {} as RunDeps["repo"],
        files,
        git,
      }),
    start: branchRun,
    clone: () => Promise.resolve("/srv/clone"),
    pollMs: 1,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  const { requestId } = await handedOver(db, files);
  await runner.tick();
  await until(async () => (await openApprovals(db, t)).length === 1);
  const [q] = await openApprovals(db, t);
  await answerApproval(db, t, q?.id ?? "", "no");
  await runner.idle();
  expect(ran.map((r) => r.args)).toEqual(looked);
  const req = await getRequest(db, t, requestId);
  expect((await getRun(db, t, req?.runId ?? ""))?.note).toBe(
    "Not pushed: fuse/fix-the-footer-1 is on HULK's copy only.",
  );
});

test("a run that changed nothing asks nothing and says so", async () => {
  const db = openTestDb();
  const files = memoryFiles();
  const { git, ran } = fakeGit({
    "rev-parse HEAD": changed["rev-parse HEAD"],
    "rev-parse origin/main": changed["rev-parse origin/main"],
  });
  const runner = new Runner({
    deps: () =>
      Promise.resolve({
        db,
        tenant: t,
        catalog: defaultCatalog,
        adapterFor: () => {
          throw new Error("no provider");
        },
        repo: {} as RunDeps["repo"],
        files,
        git,
      }),
    start: branchRun,
    clone: () => Promise.resolve("/srv/clone"),
    pollMs: 1,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  const { requestId } = await handedOver(db, files);
  await runner.tick();
  await runner.idle();
  expect(await openApprovals(db, t)).toEqual([]);
  expect(ran.map((r) => r.args)).toEqual(looked);
  const req = await getRequest(db, t, requestId);
  expect((await getRun(db, t, req?.runId ?? ""))?.note).toBe("Nothing to push: no files changed.");
});

test("a clone that fails fails the request with why", async () => {
  const db = openTestDb();
  const files = memoryFiles();
  const runner = new Runner({
    deps: () =>
      Promise.resolve({
        db,
        tenant: t,
        catalog: defaultCatalog,
        adapterFor: () => {
          throw new Error("no provider");
        },
        repo: {} as RunDeps["repo"],
        files,
      }),
    start: branchRun,
    clone: () => Promise.reject(new Error("Couldn't clone git@github.com:o/site.git: denied")),
  });
  const { requestId } = await handedOver(db, files);
  await runner.tick();
  expect(await getRequest(db, t, requestId)).toMatchObject({
    status: "failed",
    error: "Couldn't clone git@github.com:o/site.git: denied",
  });
});

describe("where HULK starts from", () => {
  const ok = (output: string) => ({ output, exitCode: 0 });
  const base = {
    "remote get-url origin": ok("git@github.com:o/site.git\n"),
    "rev-parse --abbrev-ref HEAD": ok("main\n"),
    "status --porcelain": ok(""),
    "rev-list --count origin/main..HEAD": ok("0\n"),
  };

  it("is origin and the branch checked out, when everything is pushed", async () => {
    await expect(repoOrigin(fakeGit(base).git, "f1")).resolves.toEqual({
      remote: "git@github.com:o/site.git",
      branch: "main",
    });
  });

  it("refuses work HULK can't see", async () => {
    await expect(
      repoOrigin(fakeGit({ ...base, "status --porcelain": ok(" M a.ts\n") }).git, "f1"),
    ).rejects.toThrow("Commit or stash your changes first");
    await expect(
      repoOrigin(fakeGit({ ...base, "rev-list --count origin/main..HEAD": ok("2\n") }).git, "f1"),
    ).rejects.toThrow("Push main first");
    await expect(
      repoOrigin(fakeGit({ ...base, "rev-parse --abbrev-ref HEAD": ok("HEAD\n") }).git, "f1"),
    ).rejects.toThrow("Check out a branch first");
    await expect(
      repoOrigin(
        fakeGit({ ...base, "remote get-url origin": { output: "no such remote", exitCode: 2 } })
          .git,
        "f1",
      ),
    ).rejects.toThrow("no origin remote");
  });
});
