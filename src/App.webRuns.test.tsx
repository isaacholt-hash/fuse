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

const listThreadsHere = async (db: SqlDb) =>
  (await import("@/storage/threads")).listThreads(db, DEFAULT_TENANT);

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

  // M10 step 16: a session in the Code area. The web app's run on HULK, so "This computer" is
  // greyed with why, and the cap set here reaches the runner.
  await user.keyboard("{Control>}2{/Control}");
  const where = within(await screen.findByRole("group", { name: "Where it runs" }));
  expect(where.getByRole("button", { name: "This computer" })).toBeDisabled();
  expect(where.getByRole("button", { name: "HULK" })).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.getByText("The web app runs on HULK: sessions run there, not on this computer."),
  ).toBeInTheDocument();
  const cap = screen.getByLabelText("Cost cap");
  await user.type(cap, "2.5");
  await user.tab();
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
    capMicroUsd: 2_500_000,
  });
  // The session keeps its settings, and is named for its task.
  const [session] = await listThreadsHere(db);
  expect(session).toMatchObject({
    kind: "code",
    title: "Run the tests",
    session: { capMicroUsd: 2_500_000 },
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
  // M10 step 11: the run's card has its own Stop beside the composer's; it asks the same way.
  await user.click(await screen.findByRole("button", { name: "Stop this coding run" }, SLOW));
  const stop = await nextRequest(db);
  expect(stop).toMatchObject({ kind: "stop", input: { runId: run.id } });

  // The runner stops it; the page sees that and lets you write again.
  await setRunStatus(db, t, run.id, "stopped");
  await waitFor(() => {
    expect(screen.queryAllByRole("button", { name: /^Stop/ })).toEqual([]);
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
  // M10 step 12: Runs lives in the Code area.
  await screen.findByRole("group", { name: "Area" }, SLOW);
  expect(screen.queryByRole("button", { name: /^Runs/ })).toBeNull();
  await user.keyboard("{Control>}2{/Control}");
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

test("M10 step 13: Code rows show a run going, waiting for you, or a new result, and where it runs", async () => {
  const db = openTestDb();
  const session = await createThread(db, t, "Fix the build", null, false, "code");
  const answer = await addMessage(db, t, {
    threadId: session.id,
    parentId: null,
    role: "assistant",
    content: "",
  });
  const run = await createRun(db, t, {
    projectId: null,
    threadId: session.id,
    messageId: answer,
    task: "Fix the build",
    provider: "anthropic",
    model: "m",
    capMicroUsd: 1_000_000,
  });
  const user = start(db);
  await screen.findByRole("group", { name: "Area" }, SLOW);
  await user.keyboard("{Control>}2{/Control}");
  // The row itself (its hover buttons carry their own labels: Pin, Rename, …).
  const row = () => {
    const found = within(screen.getByRole("navigation", { name: "Conversations" }))
      .getAllByRole("button", { name: /Fix the build/ })
      .find((b) => !b.hasAttribute("aria-label"));
    if (!found) throw new Error("no row for Fix the build");
    return found;
  };
  // Going, on HULK (the web app's runs all are), a Code session.
  await waitFor(() => {
    expect(within(row()).getByRole("img", { name: "Going" })).toBeInTheDocument();
  }, SLOW);
  expect(within(row()).getByLabelText("Runs on HULK")).toBeInTheDocument();
  expect(within(row()).getByLabelText("Code session")).toBeInTheDocument();
  // A question nobody has answered: waiting for you.
  await addApproval(db, t, run.id, { kind: "command", command: "git push", runId: run.id });
  await waitFor(() => {
    expect(within(row()).getByRole("img", { name: "Waiting for you" })).toBeInTheDocument();
  }, SLOW);
  // It ends while the chat isn't open: a new result, until it's opened.
  const { answerApproval, openApprovals } = await import("@/storage/runQueue");
  for (const a of await openApprovals(db, t)) await answerApproval(db, t, a.id, "no");
  await setRunStatus(db, t, run.id, "done");
  await waitFor(() => {
    expect(within(row()).getByRole("img", { name: "New result" })).toBeInTheDocument();
  }, SLOW);
  await user.click(row());
  await waitFor(() => {
    expect(within(row()).queryByRole("img")).toBeNull();
  }, SLOW);
  // Mark as unread brings it back.
  await user.click(screen.getByRole("button", { name: "Mark Fix the build as unread" }));
  await waitFor(() => {
    expect(within(row()).getByRole("img", { name: "New result" })).toBeInTheDocument();
  }, SLOW);
}, 20_000);

test("M10 step 14: a new session opens on what's happening, and a row opens its chat", async () => {
  const db = openTestDb();
  const { createProject } = await import("@/storage/projects");
  const { createSchedule } = await import("@/storage/schedules");
  const project = await createProject(db, t, "Lighthouse");
  const session = await createThread(db, t, "Deploy the docs", project.id, false, "code");
  const answer = await addMessage(db, t, {
    threadId: session.id,
    parentId: null,
    role: "assistant",
    content: "",
  });
  const run = await createRun(db, t, {
    projectId: project.id,
    threadId: session.id,
    messageId: answer,
    task: "Deploy the docs",
    provider: "anthropic",
    model: "m",
    capMicroUsd: 1_000_000,
  });
  await addApproval(db, t, run.id, { kind: "command", command: "git push", runId: run.id });
  await createSchedule(db, t, {
    projectId: project.id,
    name: "Nightly link check",
    prompt: "Check the links",
    kind: "code",
    mode: "plan",
    provider: "anthropic",
    model: "m",
    capMicroUsd: 500_000,
    repeat: "daily",
    onceAt: null,
    minute: 22 * 60,
    weekday: null,
  });
  const user = start(db);
  await screen.findByRole("group", { name: "Area" }, SLOW);
  await user.keyboard("{Control>}2{/Control}");
  const happening = within(await screen.findByLabelText("What's happening", {}, SLOW));
  const waiting = within(await happening.findByRole("region", { name: "Waiting for you" }, SLOW));
  expect(waiting.getByText(/Run git push/)).toBeInTheDocument();
  expect(
    within(happening.getByRole("region", { name: "Next scheduled" })).getByText(
      "Nightly link check",
    ),
  ).toBeInTheDocument();
  // The composer is still there under it.
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  await user.click(waiting.getByRole("button", { name: "Open Deploy the docs" }));
  expect(await screen.findByRole("heading", { name: "Deploy the docs" }, SLOW)).toBeInTheDocument();
}, 20_000);

test("M10 step 15: the Scheduled page lists every project's tasks, and a task can be paused there", async () => {
  const db = openTestDb();
  const { createProject } = await import("@/storage/projects");
  const { createSchedule, getSchedule } = await import("@/storage/schedules");
  const kitchen = await createProject(db, t, "Kitchen");
  const garden = await createProject(db, t, "Garden");
  const make = (projectId: string, name: string) =>
    createSchedule(db, t, {
      projectId,
      name,
      prompt: "Check",
      kind: "code",
      mode: "plan",
      provider: "anthropic",
      model: "m",
      capMicroUsd: 500_000,
      repeat: "daily",
      onceAt: null,
      minute: 7 * 60,
      weekday: null,
    });
  const tidy = await make(kitchen.id, "Tidy the recipes");
  await make(garden.id, "Water check");
  const user = start(db);
  await screen.findByRole("group", { name: "Area" }, SLOW);
  // The Scheduled entry is in the Code area.
  expect(screen.queryByRole("button", { name: "Scheduled" })).toBeNull();
  await user.keyboard("{Control>}2{/Control}");
  await user.click(await screen.findByRole("button", { name: "Scheduled" }, SLOW));
  const list = within(await screen.findByRole("list", { name: "Every scheduled task" }, SLOW));
  expect(list.getByText("Tidy the recipes")).toBeInTheDocument();
  expect(list.getByText("Water check")).toBeInTheDocument();
  expect(list.getByText(/Kitchen · Daily at 07:00/)).toBeInTheDocument();
  await user.click(list.getByRole("button", { name: "Pause Tidy the recipes" }));
  await waitFor(async () => {
    expect((await getSchedule(db, t, tidy.id))?.enabled).toBe(false);
  }, SLOW);
  expect(
    await within(await screen.findByRole("list", { name: "Every scheduled task" })).findByRole(
      "button",
      { name: "Resume Tidy the recipes" },
      SLOW,
    ),
  ).toBeInTheDocument();
}, 20_000);
