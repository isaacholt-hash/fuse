// @vitest-environment node
// M8 step 2 (WF-02): a run in a chat with no project, across two folders; its folders are
// recorded, so undo later reaches the right one.
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ChatMessage, ProviderAdapter, StreamEvent, ToolCall } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import type { ExecApi } from "@/repo/exec";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { grantFolder, linkThreadFolder } from "@/storage/folders";
import { listChanges, listRunFolders, listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { docxText } from "@/documents/read";
import { startRun, undoChange, type RunDeps } from "./run";

const t = DEFAULT_TENANT;
const catalogEntry = {
  provider: "anthropic",
  id: "test-claude",
  display_name: "Test Claude",
  context_window: 200000,
  max_output: 1000,
  price: { input: 1, output: 1 },
  capabilities: [] as string[],
  verified_on: "2026-10-30",
  source_url: "https://example.com",
};
const catalog = parseCatalog({ price_version: "2026-10-30", models: [catalogEntry] });
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

test("WF-01: a Work run has its own guide and no git tools, and is recorded as work", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const docs = await grantFolder(db, t, "/home/me/docs");
  await linkThreadFolder(db, t, thread.id, docs.id);
  const seen: { system: string; tools: string[] }[] = [];
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(_h, m, options): AsyncGenerator<StreamEvent> {
      seen.push({ system: options.system ?? "", tools: (options.tools ?? []).map((x) => x.name) });
      await Promise.resolve();
      yield { type: "text", text: "Here's the summary." };
      yield {
        type: "done",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: "end_turn",
        providerRequestId: null,
        attempts: 1,
        turn: { provider: "anthropic", model: m, items: [] },
      };
    },
  };
  const deps: RunDeps = { db, tenant: t, catalog, repo: filesRepo({}), adapterFor: () => adapter };
  const run = await startRun(deps, {
    projectId: null,
    threadId: thread.id,
    messageId: null,
    task: "Summarise my notes",
    model,
    mode: "auto_edit",
    kind: "work",
  });
  expect(run.kind).toBe("work");
  expect(seen[0]?.system).toContain("<work_agent>");
  expect(seen[0]?.system).not.toContain("<coding_agent>");
  expect(seen[0]?.tools).toEqual(
    expect.arrayContaining([
      "read_file",
      "read_document",
      "write_file",
      "move_file",
      "run_command",
    ]),
  );
  expect(seen[0]?.tools.some((n) => n.startsWith("git_") || n === "open_pull_request")).toBe(false);
});

test("WF-03: an image read in a run is kept and sent with its result to a vision model, every turn", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const pics = await grantFolder(db, t, "/home/me/pics");
  await linkThreadFolder(db, t, thread.id, pics.id);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const stored = new Map<string, Uint8Array>();
  const files = {
    put: (bytes: Uint8Array) => {
      const sha256 = `sha-${String(stored.size)}`;
      stored.set(sha256, bytes);
      return Promise.resolve({ sha256, size: bytes.length });
    },
    get: (sha: string) => Promise.resolve(stored.get(sha) ?? new Uint8Array()),
  };
  const repo: RepoApi = { ...filesRepo({}), readBytes: () => Promise.resolve(png) };
  const run = async (capabilities: string[]) => {
    const vision = parseCatalog({
      price_version: "2026-10-30",
      models: [{ ...catalogEntry, capabilities }],
    });
    const sent: ChatMessage[][] = [];
    const turns = [
      {
        text: "",
        calls: [
          {
            id: "c1",
            name: "read_document",
            input: { path: "cat.png", offset: null, sheet: null, range: null },
          },
        ],
      },
      {
        text: "",
        calls: [{ id: "c2", name: "list_files", input: { path: "", recursive: false } }],
      },
      { text: "A grey cat." },
    ];
    let n = 0;
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      listModels: () => Promise.resolve([]),
      async *streamChat(history, m): AsyncGenerator<StreamEvent> {
        sent.push(structuredClone(history));
        const turn = turns[n++];
        await Promise.resolve();
        yield { type: "text", text: turn?.text ?? "" };
        for (const call of turn?.calls ?? []) yield { type: "tool_call", call };
        yield {
          type: "done",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            webSearchCalls: 0,
          },
          usageReported: true,
          stopReason: turn?.calls?.length ? "tool_use" : "end_turn",
          providerRequestId: null,
          attempts: 1,
          turn: { provider: "anthropic", model: m, items: [{ n }] },
        };
      },
    };
    const deps: RunDeps = {
      db,
      tenant: t,
      catalog: vision,
      repo,
      files,
      adapterFor: () => adapter,
    };
    const r = await startRun(deps, {
      projectId: null,
      threadId: thread.id,
      messageId: null,
      task: "What's in cat.png?",
      model: vision.models[0] as CatalogModel,
      kind: "work",
    });
    return { r, sent, steps: await listSteps(db, t, r.id) };
  };
  const seen = await run(["vision"]);
  expect(seen.r.status).toBe("done");
  const result = (msgs: ChatMessage[] | undefined) =>
    msgs?.flatMap((m) => m.toolResults ?? []).find((x) => x.callId === "c1");
  // The turn right after the read, and the turn after that, both carry the image.
  expect(result(seen.sent[1])?.images).toEqual([
    { mime: "image/png", data: btoa(String.fromCharCode(...png)) },
  ]);
  expect(result(seen.sent[2])?.images?.length).toBe(1);
  const step = seen.steps.find((s) => s.kind === "tool" && s.call.id === "c1");
  expect(step?.kind === "tool" ? step.images : []).toEqual([
    { sha256: "sha-0", mime: "image/png" },
  ]);
  // A model that can't read images gets a note instead, and nothing is stored.
  const blind = await run([]);
  expect(result(blind.sent[1])?.images).toBeUndefined();
  expect(result(blind.sent[1])?.content).toMatch(/can't read images/);
});

test("WF-04: a Work run writes a Word file; undo removes it, or puts the old one back", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const docs = await grantFolder(db, t, "/home/me/docs");
  await linkThreadFolder(db, t, thread.id, docs.id);
  const disk = new Map<string, Uint8Array>();
  const stored = new Map<string, Uint8Array>();
  const sha = async (b: Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  const files = {
    put: async (bytes: Uint8Array) => {
      const sha256 = await sha(bytes);
      stored.set(sha256, bytes);
      return { sha256, size: bytes.length };
    },
    get: (s: string) => Promise.resolve(stored.get(s) ?? new Uint8Array()),
  };
  const repo: RepoApi = {
    ...filesRepo({}),
    readBytes: (_id, path) => {
      const b = disk.get(path);
      return b ? Promise.resolve(b) : Promise.reject(new Error(`${path}: no such file`));
    },
    writeBytes: (_id, path, bytes) => {
      disk.set(path, bytes);
      return Promise.resolve(path);
    },
    removeBytes: (_id, path) => {
      disk.delete(path);
      return Promise.resolve();
    },
  };
  const write = (text: string) => ({
    id: `w-${text}`,
    name: "write_document",
    input: {
      path: "summary.docx",
      title: "Summary",
      blocks: [{ kind: "paragraph", text, level: null, rows: null }],
      sheets: null,
    },
  });
  const turns = [
    { text: "", calls: [write("First draft.")] },
    { text: "", calls: [write("Second draft.")] },
    { text: "Wrote summary.docx." },
  ];
  let n = 0;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(_h, m): AsyncGenerator<StreamEvent> {
      const turn = turns[n++];
      await Promise.resolve();
      yield { type: "text", text: turn?.text ?? "" };
      for (const call of turn?.calls ?? []) yield { type: "tool_call", call };
      yield {
        type: "done",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: turn?.calls?.length ? "tool_use" : "end_turn",
        providerRequestId: null,
        attempts: 1,
        turn: { provider: "anthropic", model: m, items: [{ n }] },
      };
    },
  };
  const deps: RunDeps = { db, tenant: t, catalog, repo, files, adapterFor: () => adapter };
  const run = await startRun(deps, {
    projectId: null,
    threadId: thread.id,
    messageId: null,
    task: "Write a summary",
    model,
    mode: "auto_edit",
    kind: "work",
  });
  expect(run.status).toBe("done");
  const changes = await listChanges(db, t, run.id);
  expect(changes.map((c) => [c.before !== null, c.after])).toEqual([
    [false, "# Summary\n\nFirst draft."],
    [true, "# Summary\n\nSecond draft."],
  ]);
  expect(changes[1]?.beforeSha).toBe(changes[0]?.afterSha);
  // Undo the second: the first draft is back. Undo the first: the file is gone.
  await undoChange(deps, changes[1]?.id ?? "");
  expect(docxText(disk.get("summary.docx") ?? new Uint8Array())).toBe("# Summary\n\nFirst draft.");
  await undoChange(deps, changes[0]?.id ?? "");
  expect(disk.has("summary.docx")).toBe(false);
});

test("WF-06: an organise plan asks once, runs the moves allowed, and comes back with one Undo", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const desk = await grantFolder(db, t, "/home/me/Desktop");
  await linkThreadFolder(db, t, thread.id, desk.id);
  const disk = new Map<string, string>([
    ["IMG_1.jpg", "a"],
    ["IMG_2.jpg", "b"],
    ["taxes.pdf", "c"],
  ]);
  const moved: string[] = [];
  const repo: RepoApi = {
    ...filesRepo({}),
    move: (_id, from, to) => {
      const v = disk.get(from);
      if (v === undefined) return Promise.reject(new Error(`${from}: no such file.`));
      if (disk.has(to)) return Promise.reject(new Error(`${to} already exists.`));
      disk.delete(from);
      disk.set(to, v);
      moved.push(`${from}>${to}`);
      return Promise.resolve({ path: to, before: null });
    },
  };
  const plan = (moves: { from: string; to: string }[]) => ({
    id: `p${String(moves.length)}`,
    name: "organise",
    input: { moves, reason: "Photos together, papers together" },
  });
  const go = async (moves: { from: string; to: string }[], answer: unknown) => {
    const turns = [{ text: "", calls: [plan(moves)] }, { text: "Tidied." }];
    let n = 0;
    const asked: unknown[] = [];
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      listModels: () => Promise.resolve([]),
      async *streamChat(_h, m): AsyncGenerator<StreamEvent> {
        const turn = turns[n++];
        await Promise.resolve();
        yield { type: "text", text: turn?.text ?? "" };
        for (const call of turn?.calls ?? []) yield { type: "tool_call", call };
        yield {
          type: "done",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            webSearchCalls: 0,
          },
          usageReported: true,
          stopReason: turn?.calls?.length ? "tool_use" : "end_turn",
          providerRequestId: null,
          attempts: 1,
          turn: { provider: "anthropic", model: m, items: [{ n }] },
        };
      },
    };
    const deps: RunDeps = {
      db,
      tenant: t,
      catalog,
      repo,
      adapterFor: () => adapter,
      approve: (req) => {
        asked.push(req);
        return Promise.resolve(answer as never);
      },
    };
    // Even in "Can edit files", a plan asks.
    const r = await startRun(deps, {
      projectId: null,
      threadId: thread.id,
      messageId: null,
      task: "Tidy my desktop",
      model,
      mode: "auto_edit",
      kind: "work",
    });
    return { r, asked, deps };
  };
  const first = await go(
    [
      { from: "IMG_1.jpg", to: "Photos/IMG_1.jpg" },
      { from: "IMG_2.jpg", to: "Photos/IMG_2.jpg" },
      { from: "taxes.pdf", to: "Papers/taxes.pdf" },
    ],
    { keep: [0, 1] },
  );
  expect(first.asked).toHaveLength(1);
  expect(first.asked[0]).toMatchObject({
    kind: "organise",
    moves: [{ from: "IMG_1.jpg" }, {}, {}],
  });
  expect([...disk.keys()].sort()).toEqual(["Photos/IMG_1.jpg", "Photos/IMG_2.jpg", "taxes.pdf"]);
  const changes = await listChanges(db, t, first.r.id);
  expect(changes).toHaveLength(2);
  expect(new Set(changes.map((c) => c.batchId)).size).toBe(1);
  // One Undo, on either move, puts the whole plan back.
  await undoChange(first.deps, changes[1]?.id ?? "");
  expect([...disk.keys()].sort()).toEqual(["IMG_1.jpg", "IMG_2.jpg", "taxes.pdf"]);
  expect((await listChanges(db, t, first.r.id)).every((c) => c.status === "undone")).toBe(true);

  // A move that fails half way: the ones before it are put back; nothing stays moved.
  moved.length = 0;
  const broken = await go(
    [
      { from: "IMG_1.jpg", to: "Photos/IMG_1.jpg" },
      { from: "missing.jpg", to: "Photos/missing.jpg" },
    ],
    "yes",
  );
  const steps = await listSteps(db, t, broken.r.id);
  const step = steps.find((s) => s.kind === "tool");
  expect(step?.kind === "tool" ? step.output : "").toMatch(/nothing was moved/);
  expect([...disk.keys()].sort()).toEqual(["IMG_1.jpg", "IMG_2.jpg", "taxes.pdf"]);
});

test("WF-07: no network until allowed; a command that needed it asks, and runs again once", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const app = await grantFolder(db, t, "/home/me/app");
  await linkThreadFolder(db, t, thread.id, app.id);
  const ran: boolean[] = [];
  const exec: ExecApi = {
    sandboxKind: () => Promise.resolve("bubblewrap"),
    run: (_id, _command, opts) => {
      const net = opts.sandbox?.network ?? false;
      ran.push(net);
      return Promise.resolve(
        net
          ? {
              output: "added 3 packages",
              exitCode: 0,
              timedOut: false,
              stopped: false,
              truncated: false,
              elapsedMs: 5,
            }
          : {
              output: "npm ERR! getaddrinfo EAI_AGAIN registry.npmjs.org",
              exitCode: 1,
              timedOut: false,
              stopped: false,
              truncated: false,
              elapsedMs: 5,
            },
      );
    },
  };
  const asked: string[] = [];
  const runOnce = async () => {
    const turns = [
      {
        text: "",
        calls: [
          {
            id: "c",
            name: "run_command",
            input: { command: "npm install", timeout_seconds: null },
          },
        ],
      },
      { text: "Installed." },
    ];
    let n = 0;
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      listModels: () => Promise.resolve([]),
      async *streamChat(_h, m): AsyncGenerator<StreamEvent> {
        const turn = turns[n++];
        await Promise.resolve();
        yield { type: "text", text: turn?.text ?? "" };
        for (const call of turn?.calls ?? []) yield { type: "tool_call", call };
        yield {
          type: "done",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            webSearchCalls: 0,
          },
          usageReported: true,
          stopReason: turn?.calls?.length ? "tool_use" : "end_turn",
          providerRequestId: null,
          attempts: 1,
          turn: { provider: "anthropic", model: m, items: [{ n }] },
        };
      },
    };
    const deps: RunDeps = {
      db,
      tenant: t,
      catalog,
      repo: filesRepo({}),
      exec,
      adapterFor: () => adapter,
      approve: (req) => {
        asked.push(req.kind);
        return Promise.resolve(req.kind === "network" ? "always" : "yes");
      },
    };
    const r = await startRun(deps, {
      projectId: null,
      threadId: thread.id,
      messageId: null,
      task: "Install",
      model,
      mode: "auto_edit",
    });
    return listSteps(db, t, r.id);
  };
  const steps = await runOnce();
  // Off, refused, asked, allowed for the folder, run again with the network.
  expect(ran).toEqual([false, true]);
  expect(asked).toEqual(["command", "network"]);
  const out = steps.find((s) => s.kind === "tool");
  expect(out?.kind === "tool" ? out.output : "").toMatch(
    /added 3 packages[\s\S]*\[sandboxed, network on\]/,
  );
  // The folder keeps it: the next run has the network from the start, and doesn't ask again.
  ran.length = 0;
  asked.length = 0;
  await runOnce();
  expect(ran).toEqual([true]);
  expect(asked).toEqual(["command"]);
});
