// M10 steps 6 and 8: in the web app, runs are the server's runner's. The page asks for them,
// follows them from the database, answers their questions, and lists them with a badge. Here the
// test plays the runner, on the same in-memory database.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memoryFilesApi } from "@/files/api";
import { configureHttp } from "@/platform/http";
import { unavailableLocalAdapter } from "@/providers/local/adapter";
import type { ProviderAdapter } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addMessage } from "@/storage/messages";
import { addApproval, finishRequest, takeRequest, type RunRequest } from "@/storage/runQueue";
import { createRun, setRunStatus, type Run } from "@/storage/runs";
import type { SqlDb } from "@/storage/sql";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { fakeKeysApi } from "@/test/fakeKeysApi";
import { fakeServer } from "@/test/fakeServer";
import App from "./App";

const t = DEFAULT_TENANT;

const repo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: (path) => Promise.resolve({ root: path, name: "lighthouse", isGit: true }),
  write: () => Promise.reject(new Error("unused")),
  remove: () => Promise.reject(new Error("unused")),
  move: () => Promise.reject(new Error("unused")),
  list: () => Promise.resolve([]),
  read: () => Promise.reject(new Error("unused")),
  search: () => Promise.resolve([]),
};

/** No provider is called: the runner (this test) does the work. */
const adapterFor = (provider: "anthropic" | "openai" | "local"): ProviderAdapter => ({
  ...unavailableLocalAdapter(),
  provider,
});

function start(db: SqlDb) {
  const server = fakeServer({ setUp: true });
  server.signedIn = true;
  configureHttp({ base: "", fetch: server.fetch });
  const keys = fakeKeysApi();
  keys.keys.set("anthropic", "fake-value-for-tests-0000");
  render(
    <App
      webApp
      openDb={() => Promise.resolve(db)}
      keysApi={keys.api}
      adapterFor={adapterFor}
      files={memoryFilesApi()}
      repo={repo}
      backups={{
        list: () => Promise.resolve([]),
        backupNow: () => Promise.reject(new Error("unused")),
        restore: () => Promise.reject(new Error("unused")),
        checkFiles: () => Promise.reject(new Error("unused")),
      }}
      preview={{ url: () => Promise.resolve("about:blank") }}
      web={{ fetch: () => Promise.reject(new Error("unused")) }}
    />,
  );
  return userEvent.setup();
}

/** What the runner does when it takes a start request: the question, the answer, the run. */
async function runnerStarts(db: SqlDb, request: RunRequest): Promise<Run> {
  if (request.kind !== "start") throw new Error(`expected a start, got ${request.kind}`);
  const threadId = request.input.threadId;
  if (!threadId) throw new Error("expected a run in a chat");
  const question = await addMessage(db, t, {
    threadId,
    parentId: null,
    role: "user",
    content: request.input.task,
  });
  const answer = await addMessage(db, t, {
    threadId,
    parentId: question,
    role: "assistant",
    content: "",
    status: "streaming",
  });
  const run = await createRun(db, t, {
    projectId: request.input.projectId,
    threadId,
    messageId: answer,
    task: request.input.task,
    provider: request.input.model.provider,
    model: request.input.model.id,
    capMicroUsd: 1_000_000,
    mode: request.input.mode ?? "ask",
  });
  await finishRequest(db, t, request.id, { runId: run.id });
  return run;
}

function nextRequest(db: SqlDb): Promise<RunRequest> {
  return waitFor(
    async () => {
      const got = await takeRequest(db, t);
      if (!got) throw new Error("no request yet");
      return got;
    },
    { timeout: 3000 },
  );
}

const SLOW = { timeout: 3000 };

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

test("a Code run in the web app is asked of the runner; its question is answered here, and Stop asks it to stop", async () => {
  const db = openTestDb();
  const user = start(db);
  await user.click(await screen.findByRole("button", { name: "New project" }));
  const create = within(await screen.findByRole("dialog"));
  await user.type(create.getByLabelText("Name"), "Lighthouse");
  await user.click(create.getByRole("button", { name: "Create project" }));
  await user.click(await screen.findByRole("button", { name: "Lighthouse settings" }));
  await user.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Link a folder…" }),
  );
  await user.type(await screen.findByLabelText("Folder on HULK"), "/home/daywalker/lighthouse");
  await user.click(screen.getByRole("button", { name: "Use this folder" }));
  expect(await screen.findByText("/home/daywalker/lighthouse")).toBeInTheDocument();
  await user.keyboard("{Escape}");

  await user.click(await screen.findByRole("button", { name: "Coding run" }));
  await user.type(await screen.findByRole("textbox", { name: "Message" }), "Run the tests{Enter}");

  // The page asked; it didn't run anything itself.
  const request = await nextRequest(db);
  expect(request.kind).toBe("start");
  if (request.kind !== "start") return;
  expect(request.input).toMatchObject({
    task: "Run the tests",
    kind: "code",
    model: { provider: "anthropic" },
  });
  const run = await runnerStarts(db, request);

  // The run asks; the question shows in the chat, from the database.
  await addApproval(db, t, run.id, { kind: "command", command: "pnpm test", runId: run.id });
  const ask = within(await screen.findByRole("alertdialog", { name: "Run this command?" }, SLOW));
  expect(ask.getByText("pnpm test")).toBeInTheDocument();
  await user.click(ask.getByRole("button", { name: "Allow" }));
  await waitFor(async () => {
    const rows = await db.select<{ answer: string | null }>("SELECT answer FROM run_approvals");
    expect(rows.map((r) => r.answer)).toEqual(['"yes"']);
  });
  expect(screen.queryByRole("alertdialog", { name: "Run this command?" })).toBeNull();

  // Stop is a request to the runner.
  await user.click(await screen.findByRole("button", { name: /^Stop/ }, SLOW));
  const stop = await nextRequest(db);
  expect(stop).toMatchObject({ kind: "stop", input: { runId: run.id } });

  // The runner stops it; the page sees that and lets you write again.
  await setRunStatus(db, t, run.id, "stopped");
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  }, SLOW);
  // It waits on the page's one-second poll a few times.
}, 20_000);

test("the Runs list shows each run's status, and its badge counts waiting and newly ended runs", async () => {
  const db = openTestDb();
  const chat = await createThread(db, t, "Lighthouse docs");
  const run = async (task: string, status: Run["status"] | null, note?: string) => {
    const answer = await addMessage(db, t, {
      threadId: chat.id,
      parentId: null,
      role: "assistant",
      content: "",
    });
    const r = await createRun(db, t, {
      projectId: null,
      threadId: chat.id,
      messageId: answer,
      task,
      provider: "anthropic",
      model: "m",
      capMicroUsd: 1_000_000,
    });
    if (status) await setRunStatus(db, t, r.id, status, note);
    return r;
  };
  const waiting = await run("Deploy the docs", null);
  await addApproval(db, t, waiting.id, { kind: "command", command: "git push", runId: waiting.id });
  await run("Write the README", "done");
  await run("Fix the build", "error", "No Anthropic key yet.");
  await run("Tidy the folder", "stopped");
  await run("Check the links", null);

  const user = start(db);
  // One waiting, two ended since the list was last opened (never): 3.
  const runs = await screen.findByRole("button", { name: "Runs, 3 new" }, SLOW);
  await user.click(runs);
  const list = within(await screen.findByRole("list", { name: "Recent runs" }));
  expect(
    list.getByRole("button", { name: "Deploy the docs: Waiting for you" }),
  ).toBeInTheDocument();
  expect(list.getByRole("button", { name: "Write the README: Done" })).toBeInTheDocument();
  expect(list.getByRole("button", { name: "Fix the build: Failed" })).toBeInTheDocument();
  expect(list.getByText("No Anthropic key yet.")).toBeInTheDocument();
  expect(list.getByRole("button", { name: "Tidy the folder: Stopped" })).toBeInTheDocument();
  expect(list.getByRole("button", { name: "Check the links: Going" })).toBeInTheDocument();
  expect(list.getAllByText(/Lighthouse docs/)).toHaveLength(5);

  // Opening the list counts as seeing the ended ones; the waiting one still counts.
  expect(await screen.findByRole("button", { name: "Runs, 1 new" }, SLOW)).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 5));
  await run("Rename the files", "done");
  expect(await screen.findByRole("button", { name: "Runs, 2 new" }, SLOW)).toBeInTheDocument();

  // A row opens its chat.
  await user.click(list.getByRole("button", { name: "Deploy the docs: Waiting for you" }));
  expect(await screen.findByRole("textbox", { name: "Message" })).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Recent runs" })).toBeNull();
  // It waits on the page's one-second poll a few times.
}, 20_000);
