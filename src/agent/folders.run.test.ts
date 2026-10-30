// @vitest-environment node
// M8 step 2 (WF-02): a run in a chat with no project, across two folders; its folders are
// recorded, so undo later reaches the right one.
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ProviderAdapter, StreamEvent, ToolCall } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { grantFolder, linkThreadFolder } from "@/storage/folders";
import { listChanges, listRunFolders, listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { startRun, undoChange, type RunDeps } from "./run";

const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-10-30",
  models: [
    {
      provider: "anthropic",
      id: "test-claude",
      display_name: "Test Claude",
      context_window: 200000,
      max_output: 1000,
      price: { input: 1, output: 1 },
      capabilities: [],
      verified_on: "2026-10-30",
      source_url: "https://example.com",
    },
  ],
});
const model = catalog.models[0] as CatalogModel;

function scripted(turns: { text: string; calls?: ToolCall[] }[]): ProviderAdapter {
  let n = 0;
  return {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(_h, m): AsyncGenerator<StreamEvent> {
      const turn = turns[n++];
      await Promise.resolve();
      if (!turn) throw new Error("no more turns");
      yield { type: "text", text: turn.text };
      for (const call of turn.calls ?? []) yield { type: "tool_call", call };
      yield {
        type: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: turn.calls?.length ? "tool_use" : "end_turn",
        providerRequestId: null,
        attempts: 1,
        turn: { provider: "anthropic", model: m, items: [{ n }] },
      };
    },
  };
}

/** Files per folder id, in memory. */
function filesRepo(files: Record<string, Record<string, string>>): RepoApi {
  const at = (id: string) => (files[id] ??= {});
  return {
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("unused")),
    list: (id) =>
      Promise.resolve(
        Object.keys(at(id)).map((path) => ({ path, dir: false, size: 1, secret: false })),
      ),
    read: (id, path) => {
      const content = at(id)[path];
      return content === undefined
        ? Promise.reject(new Error(`${path}: no such file or folder.`))
        : Promise.resolve({
            path,
            content,
            offset: 0,
            totalBytes: content.length,
            truncated: false,
          });
    },
    search: () => Promise.resolve([]),
    write: (id, path, content) => {
      const before = at(id)[path] ?? null;
      at(id)[path] = content;
      return Promise.resolve({ path, before });
    },
    remove: (id, path) => {
      const folder = at(id);
      const before = folder[path] ?? null;
      files[id] = Object.fromEntries(Object.entries(folder).filter(([p]) => p !== path));
      return Promise.resolve({ path, before });
    },
    move: () => Promise.reject(new Error("unused")),
  };
}

test("a run in a chat outside any project works across its two folders, and undoes in the right one", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const notes = await grantFolder(db, t, "/home/me/notes");
  const site = await grantFolder(db, t, "/home/me/site");
  await linkThreadFolder(db, t, thread.id, notes.id);
  await linkThreadFolder(db, t, thread.id, site.id);
  const files: Record<string, Record<string, string>> = {
    [notes.id]: { "todo.md": "- ship M8\n" },
    [site.id]: { "index.html": "<h1>Hi</h1>" },
  };
  const adapter = scripted([
    {
      text: "Looking.",
      calls: [{ id: "c1", name: "list_files", input: { path: "", recursive: true } }],
    },
    {
      text: "",
      calls: [{ id: "c2", name: "read_file", input: { path: "notes/todo.md", offset: null } }],
    },
    {
      text: "",
      calls: [
        {
          id: "c3",
          name: "write_file",
          input: { path: "site/todo.html", content: "<li>ship M8</li>" },
        },
      ],
    },
    { text: "Copied the to-do list onto the site." },
  ]);
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog,
    repo: filesRepo(files),
    adapterFor: () => adapter,
  };
  const run = await startRun(deps, {
    projectId: null,
    threadId: thread.id,
    messageId: null,
    task: "Put my to-do list on the site",
    model,
    mode: "auto_edit",
  });
  expect(run).toMatchObject({ status: "done", projectId: null, kind: "code" });
  expect((await listRunFolders(db, t, run.id)).map((f) => f.label)).toEqual(["notes", "site"]);
  const steps = await listSteps(db, t, run.id);
  const listed = steps.find((s) => s.kind === "tool" && s.call.name === "list_files");
  expect(listed?.kind === "tool" ? listed.output : "").toMatch(
    /notes\/todo\.md[\s\S]*site\/index\.html/,
  );
  expect(files[site.id]?.["todo.html"]).toBe("<li>ship M8</li>");
  expect(files[notes.id]?.["todo.html"]).toBeUndefined();
  const [change] = await listChanges(db, t, run.id);
  expect(change?.path).toBe("site/todo.html");
  await undoChange(deps, change?.id ?? "");
  expect(files[site.id]?.["todo.html"]).toBeUndefined();
});

test("a chat with no folder can't start a run", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog,
    repo: filesRepo({}),
    adapterFor: () => scripted([]),
  };
  await expect(
    startRun(deps, { projectId: null, threadId: thread.id, messageId: null, task: "x", model }),
  ).rejects.toThrow(/Pick a folder/);
});
