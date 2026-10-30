// @vitest-environment node
// M6 step 13: the coding benchmark, automated. Each task runs on a fresh copy of the fixture repo
// (real files, real `node --test`, real git) through the real Anthropic and OpenAI adapters, which
// are fed each turn as that provider streams it. The model's turns are scripted, so this checks
// everything but the model: parsing, replay, tools, approvals, edits, commands, git and the
// checks. `pnpm coding:live` runs the same tasks with real models (coding.live.test.ts).
import { parseCatalog, type CatalogModel, type ProviderId } from "@/catalog/catalog";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { fakeFetch, noSleep } from "@/providers/testing/fakeFetch";
import type { ToolCall } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, type RunDeps } from "./run";
import {
  dropRepo,
  failedChecks,
  freshRepo,
  loadTasks,
  nodeExec,
  nodeGit,
  nodeRepo,
} from "./testing/bench";

interface Turn {
  text?: string;
  calls?: Omit<ToolCall, "id">[];
}

const CLAMP_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "../src/clamp.js";

test("clamp keeps values in range", () => {
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(15, 0, 10), 10);
});
`;

/** What a good model would do for each task. */
const SCRIPTS: Record<string, Turn[]> = {
  "add-test": [
    {
      text: "1. Read clamp.js.\n2. Write the test.\n3. Run it.",
      calls: [{ name: "read_file", input: { path: "src/clamp.js", offset: null } }],
    },
    { calls: [{ name: "write_file", input: { path: "test/clamp.test.js", content: CLAMP_TEST } }] },
    {
      calls: [
        {
          name: "run_command",
          input: { command: "node --test test/clamp.test.js", timeout_seconds: null },
        },
      ],
    },
    { text: "Added test/clamp.test.js with three cases; it passes." },
  ],
  "fix-across-files": [
    {
      text: "1. Run the tests.",
      calls: [{ name: "run_command", input: { command: "node --test", timeout_seconds: null } }],
    },
    {
      calls: [
        { name: "read_file", input: { path: "src/report.js", offset: null } },
        { name: "read_file", input: { path: "src/format.js", offset: null } },
        { name: "read_file", input: { path: "src/tide.js", offset: null } },
      ],
    },
    {
      text: "tideCm returns centimetres but report passes them on as metres, and formatMetres drops the decimal.",
      calls: [
        {
          name: "edit_file",
          input: {
            path: "src/report.js",
            old_text: "formatMetres(tideCm(hour))",
            new_text: "formatMetres(tideCm(hour) / 100)",
          },
        },
        {
          name: "edit_file",
          input: { path: "src/format.js", old_text: "m.toFixed(0)", new_text: "m.toFixed(1)" },
        },
      ],
    },
    { calls: [{ name: "run_command", input: { command: "node --test", timeout_seconds: null } }] },
    {
      text: "Fixed src/report.js (centimetres to metres) and src/format.js (one decimal). All tests pass.",
    },
  ],
  "commit-on-branch": [
    {
      calls: [
        {
          name: "edit_file",
          input: { path: "README.md", old_text: "# Lighthose", new_text: "# Lighthouse" },
        },
      ],
    },
    { calls: [{ name: "git_commit", input: { message: "Fix the README title", all: true } }] },
    { text: "Fixed the title and committed it." },
  ],
};

const usage = { input_tokens: 1000, output_tokens: 100 };
const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** A turn as Anthropic streams it. */
function anthropicTurn(turn: Turn, n: number): string {
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } },
  ];
  let i = 0;
  if (turn.text) {
    events.push({
      type: "content_block_start",
      index: i,
      content_block: { type: "text", text: "" },
    });
    events.push({
      type: "content_block_delta",
      index: i,
      delta: { type: "text_delta", text: turn.text },
    });
    events.push({ type: "content_block_stop", index: i++ });
  }
  (turn.calls ?? []).forEach((c, k) => {
    events.push({
      type: "content_block_start",
      index: i,
      content_block: {
        type: "tool_use",
        id: `toolu_${String(n)}_${String(k)}`,
        name: c.name,
        input: {},
      },
    });
    const json = JSON.stringify(c.input);
    // Arguments arrive in pieces, as they do for real.
    for (const part of [json.slice(0, 10), json.slice(10)]) {
      events.push({
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: part },
      });
    }
    events.push({ type: "content_block_stop", index: i++ });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: turn.calls?.length ? "tool_use" : "end_turn" },
    usage: { output_tokens: 100 },
  });
  events.push({ type: "message_stop" });
  return sse(events);
}

/** A turn as OpenAI's Responses API streams it. */
function openaiTurn(turn: Turn, n: number): string {
  const events: Record<string, unknown>[] = [{ type: "response.created", response: {} }];
  const output: Record<string, unknown>[] = [];
  if (turn.text) {
    events.push({ type: "response.output_text.delta", delta: turn.text });
    const item = {
      type: "message",
      id: `msg_${String(n)}`,
      role: "assistant",
      phase: turn.calls?.length ? "commentary" : "final_answer",
      content: [{ type: "output_text", text: turn.text }],
    };
    events.push({ type: "response.output_item.done", item });
    output.push(item);
  }
  (turn.calls ?? []).forEach((c, k) => {
    const item = {
      type: "function_call",
      id: `fc_${String(n)}_${String(k)}`,
      call_id: `call_${String(n)}_${String(k)}`,
      name: c.name,
      arguments: JSON.stringify(c.input),
    };
    events.push({ type: "response.output_item.done", item });
    output.push(item);
  });
  events.push({ type: "response.completed", response: { usage, output } });
  return sse(events);
}

const catalog = parseCatalog({
  price_version: "2026-10-30",
  models: (["anthropic", "openai"] as const).map((provider) => ({
    provider,
    id: `${provider}-balanced`,
    display_name: provider,
    context_window: 200000,
    max_output: 4000,
    price: { input: 1, output: 4 },
    capabilities: [],
    verified_on: "2026-10-30",
    source_url: "https://example.com",
  })),
});

const tasks = loadTasks();

describe.each(["anthropic", "openai"] as ProviderId[])("%s", (provider) => {
  for (const task of tasks) {
    test(`${task.id}: passes its checks`, async () => {
      const dir = freshRepo();
      try {
        const turns = SCRIPTS[task.id] ?? [];
        const body = (t: Turn, i: number) =>
          provider === "anthropic" ? anthropicTurn(t, i) : openaiTurn(t, i);
        const f = fakeFetch(
          turns.map((t, i) => ({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: body(t, i),
            chunkSize: 37,
          })),
        );
        const adapter =
          provider === "anthropic"
            ? createAnthropicAdapter({ fetch: f.fetch, retry: noSleep })
            : createOpenAIAdapter({ fetch: f.fetch, retry: noSleep });
        const db = openTestDb();
        const t = DEFAULT_TENANT;
        const project = await createProject(db, t, "Tides");
        await setProjectRepo(db, t, project.id, { root: dir, readSecrets: false });
        const deps: RunDeps = {
          db,
          tenant: t,
          catalog,
          adapterFor: () => adapter,
          repo: nodeRepo(dir),
          exec: nodeExec(dir),
          git: nodeGit(dir),
          approve: () => Promise.resolve(true),
        };
        const model = catalog.models.find((m) => m.provider === provider) as CatalogModel;
        const run = await startRun(deps, {
          projectId: project.id,
          threadId: null,
          messageId: null,
          task: task.task,
          model,
          mode: task.mode,
          newBranch: task.newBranch,
        });
        expect(run.status, run.note ?? "").toBe("done");
        expect(failedChecks(dir, task.checks)).toEqual([]);
        // One request per scripted turn, and no tool failed (a test run may fail on purpose).
        expect(f.sent).toHaveLength(turns.length);
        const failed = (await listSteps(db, t, run.id)).flatMap((s) =>
          s.kind === "tool" && s.isError && s.call.name !== "run_command" ? [s.call.name] : [],
        );
        expect(failed).toEqual([]);
      } finally {
        dropRepo(dir);
      }
    }, 30_000);
  }
});

test("the fixture's bug is real: before a fix, its tests fail", () => {
  const dir = freshRepo();
  try {
    expect(failedChecks(dir, [{ kind: "command_passes", command: "node --test" }])).toEqual([
      "`node --test` fails",
    ]);
  } finally {
    dropRepo(dir);
  }
});
