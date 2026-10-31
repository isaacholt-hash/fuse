// @vitest-environment node
// M6 step 5: coding runs, read-only. A scripted provider stands in for the model.
import { asData } from "./untrusted";
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { ProviderError } from "@/providers/errors";
import type {
  ChatMessage,
  ChatOptions,
  ProviderAdapter,
  StreamEvent,
  ToolCall,
} from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addDecision } from "@/storage/memories";
import { createProject, setProjectRepo } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import { getRun, listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { continueRun, runAnswer, startRun, type RunDeps } from "./run";
import { GIT_READ_TOOLS, READ_ONLY_TOOLS } from "./tools";

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
      price: { input: 2, output: 10 },
      capabilities: [],
      verified_on: "2026-10-30",
      source_url: "https://example.com",
    },
  ],
});
const model = catalog.models[0] as CatalogModel;

const FILES: Record<string, string> = {
  "README.md": "# Lighthouse\n",
  "src/app/tide.ts": "export const tide = 3;\n",
  "src/app/AGENTS.md": "Tides are in metres.",
  "CLAUDE.md": "Use pnpm.",
};
const repo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: () => Promise.reject(new Error("unused")),
  write: () => Promise.reject(new Error("read-only in this test")),
  remove: () => Promise.reject(new Error("read-only in this test")),
  move: () => Promise.reject(new Error("read-only in this test")),
  list: () =>
    Promise.resolve([
      { path: "README.md", dir: false, size: 13, secret: false },
      { path: "src", dir: true, size: 0, secret: false },
    ]),
  search: () =>
    Promise.resolve([{ path: "src/app/tide.ts", line: 1, text: "export const tide = 3;" }]),
  read: (_p, path) => {
    const content = FILES[path];
    return content === undefined
      ? Promise.reject(new Error(`${path}: no such file or folder.`))
      : Promise.resolve({ path, content, offset: 0, totalBytes: content.length, truncated: false });
  },
};

type Turn = { text: string; calls?: ToolCall[] } | ProviderError;

/** A provider that answers each request with the next scripted turn. */
function scripted(turns: Turn[]) {
  const sent: { history: ChatMessage[]; options: ChatOptions }[] = [];
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(history, m, options): AsyncGenerator<StreamEvent> {
      sent.push({ history: structuredClone(history), options: structuredClone(options) });
      const turn = turns[sent.length - 1];
      await Promise.resolve();
      if (!turn) throw new Error("no more turns scripted");
      if (turn instanceof ProviderError) throw turn;
      yield { type: "text", text: turn.text };
      for (const call of turn.calls ?? []) yield { type: "tool_call", call };
      yield {
        type: "done",
        usage: {
          inputTokens: 100_000,
          outputTokens: 10_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: turn.calls?.length ? "tool_use" : "end_turn",
        providerRequestId: `req_${String(sent.length)}`,
        attempts: 1,
        turn: { provider: "anthropic", model: m, items: [{ turn: sent.length }] },
      };
    },
  };
  return { adapter, sent };
}

async function setup(turns: Turn[]) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const { adapter, sent } = scripted(turns);
  const deps: RunDeps = { db, tenant: t, catalog, adapterFor: () => adapter, repo };
  const start = (over: { capMicroUsd?: number; signal?: AbortSignal } = {}) =>
    startRun(deps, {
      projectId: project.id,
      threadId: null,
      messageId: null,
      task: "How high is the tide?",
      model,
      ...over,
    });
  return { db, deps, project, sent, start };
}

const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({
  id,
  name,
  input,
});

// 100k input at $2/M + 10k output at $10/M = $0.30 a turn.
const TURN_COST = 300_000;

test("a run: plan, tool calls, results replayed, answer; every turn priced and logged", async () => {
  const { db, sent, start } = await setup([
    {
      text: "1. Find the tide code.",
      calls: [
        call("c1", "search_files", { query: "tide", path: null, ignore_case: false }),
        call("c2", "read_file", { path: "src/app/tide.ts", offset: null }),
      ],
    },
    { text: "The tide is 3 metres (src/app/tide.ts:1)." },
  ]);
  const run = await start();
  expect(run).toMatchObject({ status: "done", spentMicroUsd: 2 * TURN_COST, mode: "plan" });
  const steps = await listSteps(db, t, run.id);
  expect(steps.map((s) => (s.kind === "tool" ? s.call.name : "model"))).toEqual([
    "model",
    "search_files",
    "read_file",
    "model",
  ]);
  expect(runAnswer(steps)).toBe("The tide is 3 metres (src/app/tide.ts:1).");

  // The second request replays the first turn unchanged, then both results in one message.
  const second = sent[1]?.history ?? [];
  expect(second[1]).toEqual({
    role: "assistant",
    content: "1. Find the tide code.",
    native: { provider: "anthropic", model: "test-claude", items: [{ turn: 1 }] },
  });
  expect(second[2]?.toolResults).toEqual([
    {
      callId: "c1",
      content: asData("search_files", "src/app/tide.ts:1: export const tide = 3;"),
      isError: false,
    },
    { callId: "c2", content: asData("read_file", "export const tide = 3;\n"), isError: false },
  ]);
  // Same tools every turn; the project scope for the Rust egress check.
  expect(
    sent.every(
      (s) =>
        s.options.tools?.map((x) => x.name).join() ===
        [...READ_ONLY_TOOLS, ...GIT_READ_TOOLS].map((x) => x.name).join(),
    ),
  ).toBe(true);
  expect(sent[0]?.options.scope).toEqual({ kind: "project", id: run.projectId });

  // Nested instructions arrive once the run works in that folder (CA-06).
  expect(sent[0]?.options.system).toContain("Use pnpm.");
  expect(sent[0]?.options.system).not.toContain("Tides are in metres.");
  expect(sent[1]?.options.system).toContain('<repository_file path="src/app/AGENTS.md">');

  const log = (await listRecentRequests(db, t)).filter((r) => r.purpose === "agent");
  expect(log).toHaveLength(2);
  expect(log.reduce((sum, r) => sum + r.usage.costMicroUsd, 0)).toBe(2 * TURN_COST);
});

test("a failing tool call is a result, and the run goes on", async () => {
  const { db, sent, start } = await setup([
    { text: "Reading.", calls: [call("c1", "read_file", { path: "nope.ts", offset: null })] },
    { text: "There's no nope.ts." },
  ]);
  const run = await start();
  expect(run.status).toBe("done");
  const tool = (await listSteps(db, t, run.id)).find((s) => s.kind === "tool");
  expect(tool).toMatchObject({ isError: true, output: "Error: nope.ts: no such file or folder." });
  expect(sent[1]?.history[2]?.toolResults?.[0]?.isError).toBe(true);
});

test("the cost cap pauses the run; continuing with more lets it finish", async () => {
  const { db, deps, sent, start } = await setup([
    { text: "1. Look.", calls: [call("c1", "list_files", { path: "", recursive: false })] },
    { text: "Done looking." },
  ]);
  const paused = await start({ capMicroUsd: TURN_COST });
  expect(paused).toMatchObject({ status: "paused", spentMicroUsd: TURN_COST });
  expect(paused.note).toMatch(/cost cap/);
  expect(sent).toHaveLength(1);
  const done = await continueRun(deps, paused.id, { raiseCapBy: 1_000_000 });
  expect(done).toMatchObject({ status: "done", capMicroUsd: TURN_COST + 1_000_000 });
  expect(sent).toHaveLength(2);
  // Resumed from the record: the first turn and its result replayed unchanged.
  expect(sent[1]?.history[2]?.toolResults?.[0]?.content).toBe(
    asData("list_files", "README.md (13 bytes)\nsrc/"),
  );
  expect(runAnswer(await listSteps(db, t, done.id))).toBe("Done looking.");
});

test("stop and provider errors end the run with a reason", async () => {
  const ac = new AbortController();
  ac.abort();
  const stopped = await (await setup([{ text: "x" }])).start({ signal: ac.signal });
  expect(stopped).toMatchObject({ status: "stopped", note: "Stopped." });

  const { db, start } = await setup([new ProviderError("auth", "bad key", { status: 401 })]);
  const failed = await start();
  expect(failed).toMatchObject({
    status: "error",
    note: "Anthropic rejected the API key. Check it in Settings.",
  });
  const log = (await listRecentRequests(db, t)).find((r) => r.purpose === "agent");
  expect(log).toMatchObject({ httpStatus: 401, errorCode: "auth" });
  expect((await getRun(db, t, failed.id))?.spentMicroUsd).toBe(0);
});

test("the project's decisions and constraints go with every turn", async () => {
  const { db, project, sent, start } = await setup([{ text: "OK." }]);
  await addDecision(db, t, project.id, {
    text: "Tides in metres",
    rationale: "UK charts",
    alternatives: [],
  });
  await start();
  expect(sent[0]?.options.system).toContain("Decision: Tides in metres Reason: UK charts");
  expect(sent[0]?.options.system).toContain("<coding_agent>");
});
