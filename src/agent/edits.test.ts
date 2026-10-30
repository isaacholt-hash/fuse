// @vitest-environment node
// M6 step 6: runs that edit files, and undo (CA-02). An in-memory repository stands in for Rust.
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ProviderAdapter, StreamEvent, ToolCall, ToolSpec } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { listChanges, listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, undoChange, undoRun, type RunDeps } from "./run";

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

function memoryRepo(files: Record<string, string>): RepoApi & { files: Map<string, string> } {
  const fs = new Map(Object.entries(files));
  const missing = (p: string) => Promise.reject(new Error(`${p}: no such file.`));
  return {
    files: fs,
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("unused")),
    list: () =>
      Promise.resolve([...fs.keys()].map((path) => ({ path, dir: false, size: 1, secret: false }))),
    search: () => Promise.resolve([]),
    read: (_p, path) => {
      const content = fs.get(path);
      return content === undefined
        ? missing(path)
        : Promise.resolve({
            path,
            content,
            offset: 0,
            totalBytes: content.length,
            truncated: false,
          });
    },
    write: (_p, path, content) => {
      const before = fs.get(path) ?? null;
      fs.set(path, content);
      return Promise.resolve({ path, before });
    },
    remove: (_p, path) => {
      const before = fs.get(path);
      if (before === undefined) return missing(path);
      fs.delete(path);
      return Promise.resolve({ path, before });
    },
    move: (_p, from, to) => {
      const content = fs.get(from);
      if (content === undefined) return missing(from);
      if (fs.has(to)) return Promise.reject(new Error(`${to} already exists.`));
      fs.delete(from);
      fs.set(to, content);
      return Promise.resolve({ path: to, before: null });
    },
  };
}

function scripted(turns: ToolCall[][]) {
  const tools: ToolSpec[][] = [];
  let n = 0;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(_h, m, options): AsyncGenerator<StreamEvent> {
      tools.push(options.tools ?? []);
      const calls = turns[n++] ?? [];
      await Promise.resolve();
      yield { type: "text", text: calls.length ? "Working." : "Done: see the diffs." };
      for (const call of calls) yield { type: "tool_call", call };
      yield {
        type: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: calls.length ? "tool_use" : "end_turn",
        providerRequestId: null,
        attempts: 1,
        turn: { provider: "anthropic", model: m, items: [] },
      };
    },
  };
  return { adapter, tools };
}

const call = (name: string, input: Record<string, unknown>, id = name): ToolCall => ({
  id,
  name,
  input,
});

async function setup(turns: ToolCall[][], files: Record<string, string>) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const repo = memoryRepo(files);
  const { adapter, tools } = scripted(turns);
  const deps: RunDeps = { db, tenant: t, catalog, adapterFor: () => adapter, repo };
  const run = (mode: "plan" | "auto_edit") =>
    startRun(deps, {
      projectId: project.id,
      threadId: null,
      messageId: null,
      task: "Fix it",
      model,
      mode,
    });
  return { db, deps, repo, tools, run };
}

test("an editing run changes files and records each change with what was there", async () => {
  const { db, repo, tools, run } = await setup(
    [
      [
        call("edit_file", { path: "src/tide.ts", old_text: "= 3", new_text: "= 4" }),
        call("write_file", { path: "src/new.ts", content: "export {};\n" }),
        call("delete_file", { path: "old.txt" }),
        call("move_file", { from: "notes.md", to: "docs/notes.md" }),
      ],
      [],
    ],
    { "src/tide.ts": "export const tide = 3;\n", "old.txt": "bye\n", "notes.md": "# Notes\n" },
  );
  const r = await run("auto_edit");
  expect(r.status).toBe("done");
  expect(Object.fromEntries(repo.files)).toEqual({
    "src/tide.ts": "export const tide = 4;\n",
    "src/new.ts": "export {};\n",
    "docs/notes.md": "# Notes\n",
  });
  const changes = await listChanges(db, t, r.id);
  expect(changes.map((c) => [c.path, c.fromPath, c.before, c.after])).toEqual([
    ["src/tide.ts", null, "export const tide = 3;\n", "export const tide = 4;\n"],
    ["src/new.ts", null, null, "export {};\n"],
    ["old.txt", null, "bye\n", null],
    ["docs/notes.md", "notes.md", null, null],
  ]);
  expect(tools[0]?.map((x) => x.name)).toEqual([
    "list_files",
    "read_file",
    "search_files",
    "edit_file",
    "write_file",
    "delete_file",
    "move_file",
    "run_command",
  ]);
});

test("edit_file needs old_text exactly once", async () => {
  const { db, repo, run } = await setup(
    [
      [
        call("edit_file", { path: "a.ts", old_text: "x", new_text: "y" }),
        call("edit_file", { path: "a.ts", old_text: "zzz", new_text: "y" }, "e2"),
      ],
      [],
    ],
    { "a.ts": "x x\n" },
  );
  const r = await run("auto_edit");
  const outputs = (await listSteps(db, t, r.id)).flatMap((s) =>
    s.kind === "tool" ? [s.output] : [],
  );
  expect(outputs).toEqual([
    "Error: old_text appears 2 times in a.ts; include more lines so it's unique.",
    "Error: old_text isn't in a.ts. Read the file and copy it exactly.",
  ]);
  expect(repo.files.get("a.ts")).toBe("x x\n");
});

test("a read-only run never changes files, and isn't offered the tools", async () => {
  const { db, repo, tools, run } = await setup(
    [[call("write_file", { path: "a.ts", content: "!" })], []],
    { "a.ts": "ok\n" },
  );
  const r = await run("plan");
  expect(repo.files.get("a.ts")).toBe("ok\n");
  expect(tools[0]?.some((x) => x.name === "write_file")).toBe(false);
  expect((await listSteps(db, t, r.id)).find((s) => s.kind === "tool")).toMatchObject({
    isError: true,
    output: "Error: this run is read-only.",
  });
  expect(await listChanges(db, t, r.id)).toEqual([]);
});

test("undo one change, refuse when the file changed since, undo a whole run newest first", async () => {
  const { db, deps, repo, run } = await setup(
    [
      [
        call("edit_file", { path: "a.ts", old_text: "1", new_text: "2" }),
        call("write_file", { path: "b.ts", content: "new\n" }),
        call("move_file", { from: "c.md", to: "d/c.md" }),
      ],
      [],
    ],
    { "a.ts": "v1\n", "c.md": "c\n" },
  );
  const r = await run("auto_edit");
  const [edit, created] = await listChanges(db, t, r.id);
  repo.files.set("a.ts", "v2 and my own edit\n");
  await expect(undoChange(deps, edit?.id ?? "")).rejects.toThrow(/has changed since/);
  repo.files.set("a.ts", "v2\n");
  await undoChange(deps, created?.id ?? "");
  expect(repo.files.has("b.ts")).toBe(false);
  await undoRun(deps, r.id);
  expect(Object.fromEntries(repo.files)).toEqual({ "a.ts": "v1\n", "c.md": "c\n" });
  expect((await listChanges(db, t, r.id)).every((c) => c.status === "undone")).toBe(true);
  // Undoing again does nothing.
  await undoRun(deps, r.id);
  expect(Object.fromEntries(repo.files)).toEqual({ "a.ts": "v1\n", "c.md": "c\n" });
});
