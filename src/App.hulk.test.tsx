// M10 steps 7 and 8, desktop: pairing with HULK, "Run on HULK", the run's card, and the
// notification when it needs a look. HULK is a fake link over a second in-memory database.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memoryFilesApi } from "@/files/api";
import type { HulkApi, HulkStatus } from "@/handover/api";
import { unavailableLocalAdapter } from "@/providers/local/adapter";
import type { ProviderAdapter } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import type { GitApi } from "@/repo/git";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addApproval } from "@/storage/runQueue";
import { createRun, setRunStatus } from "@/storage/runs";
import type { SqlValue } from "@/storage/sql";
import { openTestDb } from "@/storage/testing/nodeDb";
import { fakeKeysApi } from "@/test/fakeKeysApi";
import App from "./App";

const t = DEFAULT_TENANT;

const repo: RepoApi = {
  pick: () => Promise.resolve({ root: "/home/me/site", name: "site", isGit: true }),
  check: () => Promise.reject(new Error("unused")),
  write: () => Promise.reject(new Error("unused")),
  remove: () => Promise.reject(new Error("unused")),
  move: () => Promise.reject(new Error("unused")),
  list: () => Promise.resolve([]),
  read: () => Promise.reject(new Error("unused")),
  search: () => Promise.resolve([]),
};

const adapterFor = (provider: "anthropic" | "openai" | "local"): ProviderAdapter => ({
  ...unavailableLocalAdapter(),
  provider,
});

/** HULK: pairing, and its database and file store behind the link. */
function fakeHulk(paired: boolean) {
  const db = openTestDb();
  const initial: HulkStatus = { address: paired ? "https://hulk.test:4100" : null, paired };
  const state = {
    db,
    status: initial,
    pairs: [] as { address: string; code: string; name: string }[],
    files: 0,
  };
  const api: HulkApi = {
    status: () => Promise.resolve(state.status),
    pair: (address, code, name) => {
      state.pairs.push({ address, code, name });
      if (code !== "ABCD-EFGH") return Promise.reject(new Error("That isn't right."));
      state.status = { address, paired: true };
      return Promise.resolve(state.status);
    },
    unpair: () => {
      state.status = { address: state.status.address, paired: false };
      return Promise.resolve(state.status);
    },
    invoke: async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      const sql = args.sql as string;
      const params = (args.params ?? []) as SqlValue[];
      if (command === "db_open") return null as T;
      if (command === "db_execute") return (await db.execute(sql, params)) as T;
      if (command === "db_select") return (await db.select(sql, params)) as T;
      throw new Error(`unknown_command: ${command}`);
    },
    putFile: (bytes) => {
      state.files++;
      return Promise.resolve({ sha256: `sha-${String(state.files)}`, size: bytes.length });
    },
  };
  return { state, api };
}

/** git in the project's folder: on main, pushed, unless `ahead` says otherwise. */
function fakeGit(ahead = "0"): GitApi {
  return {
    run: (_folder, _program, args) => {
      const key = args.join(" ");
      const output =
        key === "remote get-url origin"
          ? "git@github.com:me/site.git\n"
          : key === "rev-parse --abbrev-ref HEAD"
            ? "main\n"
            : key === "status --porcelain"
              ? ""
              : key.startsWith("rev-list")
                ? `${ahead}\n`
                : "";
      return Promise.resolve({ output, exitCode: 0 });
    },
  };
}

function start(hulk: HulkApi, git: GitApi = fakeGit()) {
  const shown: { title: string; body: string }[] = [];
  const keys = fakeKeysApi();
  keys.keys.set("anthropic", "fake-value-for-tests-0000");
  render(
    <App
      openDb={() => Promise.resolve(openTestDb())}
      keysApi={keys.api}
      adapterFor={adapterFor}
      files={memoryFilesApi()}
      repo={repo}
      git={git}
      hulk={hulk}
      notify={(title, body) => {
        shown.push({ title, body });
        return Promise.resolve(true);
      }}
      hulkPollMs={{ card: 100, notify: 100 }}
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
  return { shown, user: userEvent.setup() };
}

/** A project "Site" with its repository folder linked, and the Coding run switched on. */
async function codeInProject(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "New project" }));
  const create = within(await screen.findByRole("dialog"));
  await user.type(create.getByLabelText("Name"), "Site");
  await user.click(create.getByRole("button", { name: "Create project" }));
  await user.click(await screen.findByRole("button", { name: "Site settings" }));
  const settings = within(await screen.findByRole("dialog"));
  await user.click(settings.getByRole("button", { name: "Link a folder…" }));
  await settings.findByText("/home/me/site");
  await user.keyboard("{Escape}");
  // M10 step 16: a session in the Code area; the project comes along.
  await user.keyboard("{Control>}2{/Control}");
  await user.click(await screen.findByRole("button", { name: "Coding run" }));
}

/** M10 step 16: Where = HULK, then the task is sent: it's handed over, not run here. */
async function sendToHulk(user: ReturnType<typeof userEvent.setup>, task: string) {
  await user.click(
    within(await screen.findByRole("group", { name: "Where it runs" })).getByRole("button", {
      name: "HULK",
    }),
  );
  await user.type(await screen.findByRole("textbox", { name: "Message" }), `${task}{Enter}`);
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

test("Settings → HULK pairs with a code (the server's error shows), then unpairs", async () => {
  const hulk = fakeHulk(false);
  const { user } = start(hulk.api);
  await screen.findByRole("complementary", { name: "Chat sidebar" });
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "HULK" }));
  await user.type(section.getByLabelText("HULK's address"), "https://hulk.test:4100");
  await user.type(section.getByLabelText("Pairing code"), "WRONG-CODE");
  expect(section.getByLabelText("This computer's name on HULK")).toHaveValue("This desktop");
  await user.click(section.getByRole("button", { name: "Pair" }));
  expect(await section.findByRole("alert")).toHaveTextContent("That isn't right.");

  await user.clear(section.getByLabelText("Pairing code"));
  await user.type(section.getByLabelText("Pairing code"), "ABCD-EFGH");
  await user.click(section.getByRole("button", { name: "Pair" }));
  const paired = within(await screen.findByRole("region", { name: "HULK" }));
  expect(await paired.findByText("Paired")).toBeInTheDocument();
  expect(paired.getByText("https://hulk.test:4100")).toBeInTheDocument();
  expect(paired.getByRole("button", { name: "Open HULK" })).toBeInTheDocument();
  expect(paired.getByText(/Revoke the device in HULK's/)).toBeInTheDocument();
  expect(hulk.state.pairs.at(-1)).toEqual({
    address: "https://hulk.test:4100",
    code: "ABCD-EFGH",
    name: "This desktop",
  });

  await user.click(paired.getByRole("button", { name: "Unpair" }));
  expect(
    await within(await screen.findByRole("region", { name: "HULK" })).findByRole("button", {
      name: "Pair",
    }),
  ).toBeInTheDocument();
  expect(hulk.state.status.paired).toBe(false);
});

test("not paired, HULK as the place to run is greyed with the reason", async () => {
  const { user } = start(fakeHulk(false).api);
  await codeInProject(user);
  const button = within(await screen.findByRole("group", { name: "Where it runs" })).getByRole(
    "button",
    { name: "HULK" },
  );
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", "Pair with HULK in Settings first");
  expect(screen.getByText("Pair with HULK in Settings first")).toBeInTheDocument();
});

test("a repository with unpushed work is refused, with repoOrigin's words", async () => {
  const hulk = fakeHulk(true);
  const { user } = start(hulk.api, fakeGit("2"));
  await codeInProject(user);
  await sendToHulk(user, "Add a footer");
  expect(
    await screen.findByText(/Push main first: HULK works from what's on origin\./),
  ).toBeInTheDocument();
  expect(await hulk.state.db.select("SELECT id FROM run_requests")).toEqual([]);
});

test("a session on HULK hands its task over, the card follows it, and a change is a notification", async () => {
  const hulk = fakeHulk(true);
  const { user, shown } = start(hulk.api);
  await codeInProject(user);
  await sendToHulk(user, "Add a footer note");

  // The request on HULK: the task, the routed model, the composer's mode, the repo's origin.
  await waitFor(async () => {
    expect(await hulk.state.db.select("SELECT id FROM run_requests")).toHaveLength(1);
  });
  const [req] = await hulk.state.db.select<{ id: string; kind: string; input: string }>(
    "SELECT id, kind, input FROM run_requests",
  );
  expect(req?.kind).toBe("start");
  expect(JSON.parse(req?.input ?? "{}")).toMatchObject({
    threadId: null,
    task: "Add a footer note",
    kind: "code",
    mode: "ask",
    newBranch: true,
    model: { provider: "anthropic" },
    handover: { exportSha: "sha-1", remote: "git@github.com:me/site.git", branch: "main" },
  });
  expect(hulk.state.files).toBe(1);

  // The chat's card, and its status from HULK.
  const cards = within(await screen.findByRole("list", { name: "Runs on HULK" }));
  expect(cards.getByText("Running on HULK: Add a footer note")).toBeInTheDocument();
  expect(await cards.findByText("Starting on HULK")).toBeInTheDocument();
  // It survives a reload: the request id is kept by chat.
  expect(JSON.parse(localStorage.getItem("fuse.handovers") ?? "[]")).toMatchObject([
    { requestId: req?.id, task: "Add a footer note" },
  ]);

  // HULK's runner takes it: going on its branch, then a question for you.
  const run = await createRun(hulk.state.db, t, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "Add a footer note",
    provider: "anthropic",
    model: "m",
    capMicroUsd: 1_000_000,
  });
  await hulk.state.db.execute("UPDATE runs SET branch = 'fuse/abc123' WHERE id = ?", [run.id]);
  await hulk.state.db.execute("UPDATE run_requests SET status = 'done', run_id = ? WHERE id = ?", [
    run.id,
    req?.id ?? "",
  ]);
  expect(await cards.findByText("Going · fuse/abc123")).toBeInTheDocument();
  expect(shown).toEqual([]);

  await addApproval(hulk.state.db, t, run.id, { kind: "git", runId: run.id });
  expect(await cards.findByText("Waiting for you · fuse/abc123")).toBeInTheDocument();
  await waitFor(() => {
    expect(shown).toEqual([{ title: "FUSE on HULK: Waiting for you", body: "Add a footer note" }]);
  });

  // Answered on HULK and done: one more notification.
  await hulk.state.db.execute("UPDATE run_approvals SET answer = '\"yes\"', answered_at = 1");
  await act(async () => {
    await setRunStatus(hulk.state.db, t, run.id, "done", "Pushed fuse/abc123.");
  });
  expect(await cards.findByText(/^Done · fuse\/abc123/)).toBeInTheDocument();
  await waitFor(() => {
    expect(shown.map((n) => n.title)).toEqual([
      "FUSE on HULK: Waiting for you",
      "FUSE on HULK: Done",
    ]);
  });
}, 20_000);
