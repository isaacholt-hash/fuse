// @vitest-environment node
// M9 step 9 (AG-02): a project's MCP servers' tools in runs.
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { memoryFilesApi } from "@/files/api";
import type { McpTool } from "@/mcp/api";
import { anthropicTool } from "@/providers/anthropic/adapter";
import { openaiTool } from "@/providers/openai/adapter";
import type { ProviderAdapter, StreamEvent, ToolCall, ToolSpec } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { mcpToolName, startRun, type ApprovalRequest, type McpRunApi, type RunDeps } from "./run";

const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-10-31",
  models: [
    {
      provider: "anthropic",
      id: "test-claude",
      display_name: "Test Claude",
      context_window: 200000,
      max_output: 1000,
      price: { input: 1, output: 1 },
      capabilities: ["tools", "vision"],
      verified_on: "2026-10-31",
      source_url: "https://example.com",
    },
  ],
});
const model = catalog.models[0] as CatalogModel;
const unused = () => Promise.reject(new Error("unused"));
const repo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: unused,
  list: () => Promise.resolve([]),
  search: () => Promise.resolve([]),
  read: unused,
  write: unused,
  remove: unused,
  move: unused,
};

const tool = (name: string, readOnly: boolean, destructive: boolean | null = null): McpTool => ({
  name,
  description: `${name} things`,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  readOnly,
  destructive,
});

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
      yield { type: "text", text: calls.length ? "Working." : "Done." };
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

const call = (name: string, input: Record<string, unknown> = { q: "x" }, id = name): ToolCall => ({
  id,
  name,
  input,
});

async function setup(mode: "plan" | "ask" | "auto_edit", turns: ToolCall[][], failCall = false) {
  const db = openTestDb();
  const project = await createProject(db, t, "Notes work");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const called: string[] = [];
  const mcp: McpRunApi = {
    forProject: () =>
      Promise.resolve([
        { id: "s1", name: "Notes" },
        { id: "s2", name: "Broken" },
      ]),
    tools: (id) =>
      id === "s1"
        ? Promise.resolve([
            tool("search", true),
            tool("add note", false),
            tool("wipe", false, true),
          ])
        : Promise.reject(new Error("crashed on start")),
    call: (_id, name, args) => {
      called.push(`${name} ${JSON.stringify(args)}`);
      if (failCall) return Promise.reject(new Error("The server stopped."));
      return Promise.resolve({
        parts: [
          { kind: "text", text: `${name} done`, mime: null, data: null },
          ...(name === "search"
            ? [{ kind: "image" as const, text: null, mime: "image/png", data: btoa("png!") }]
            : []),
        ],
        isError: false,
      });
    },
  };
  const { adapter, tools } = scripted(turns);
  const asked: ApprovalRequest[] = [];
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog,
    adapterFor: () => adapter,
    repo,
    mcp,
    files: memoryFilesApi(),
    approve: (req) => {
      asked.push(req);
      return Promise.resolve("yes");
    },
  };
  const r = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Look after the notes",
    model,
    mode,
  });
  const steps = await listSteps(db, t, r.id);
  return { r, tools, asked, called, steps };
}

test("a project's server's tools are offered, non-strict; reads run, writes run in Auto-edit, destructive asks", async () => {
  const { r, tools, asked, called, steps } = await setup("auto_edit", [
    [call("mcp__Notes__search"), call("mcp__Notes__add_note"), call("mcp__Notes__wipe")],
    [],
  ]);
  expect(r.status).toBe("done");
  const offered = tools[0]?.filter((x) => x.name.startsWith("mcp__")) ?? [];
  expect(offered.map((x) => [x.name, x.strict])).toEqual([
    ["mcp__Notes__search", false],
    ["mcp__Notes__add_note", false],
    ["mcp__Notes__wipe", false],
  ]);
  expect(offered[0]?.description).toBe("[Notes, an MCP server] search things");
  // The broken server is left out; the run carried on.
  expect(tools[0]?.some((x) => x.name.includes("Broken"))).toBe(false);
  expect(called).toEqual(['search {"q":"x"}', 'add note {"q":"x"}', 'wipe {"q":"x"}']);
  expect(asked).toEqual([
    expect.objectContaining({ kind: "mcp", server: "Notes", tool: "wipe", destructive: true }),
  ]);
  const search = steps.find((s) => s.kind === "tool" && s.call.name === "mcp__Notes__search");
  expect(search).toMatchObject({ output: "search done", isError: false, approval: "auto" });
  expect(search?.kind === "tool" && search.images.map((i) => i.mime)).toEqual(["image/png"]);
});

test("Ask first asks for a write; a read-only run gets only the read tools and refuses the rest", async () => {
  const ask = await setup("ask", [[call("mcp__Notes__add_note")], []]);
  expect(ask.asked.map((a) => a.kind)).toEqual(["mcp"]);

  const plan = await setup("plan", [[call("mcp__Notes__add_note")], []]);
  expect(plan.tools[0]?.filter((x) => x.name.startsWith("mcp__")).map((x) => x.name)).toEqual([
    "mcp__Notes__search",
  ]);
  expect(plan.called).toEqual([]);
});

test("a server that fails mid-run gives an error result, and the run goes on", async () => {
  const { r, steps } = await setup("auto_edit", [[call("mcp__Notes__search")], []], true);
  expect(r.status).toBe("done");
  expect(steps.find((s) => s.kind === "tool")).toMatchObject({
    isError: true,
    output: "Error: the MCP server Notes didn't answer: The server stopped.",
  });
});

test("tool names are provider-safe, at most 64 characters, and unique", () => {
  const taken = new Set<string>();
  expect(mcpToolName("My Notes!", "add note", taken)).toBe("mcp__My_Notes__add_note");
  expect(mcpToolName("My Notes!", "add note", taken)).toBe("mcp__My_Notes__add_note_2");
  const long = mcpToolName("server", "x".repeat(100), taken);
  expect(long.length).toBe(64);
  expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("a non-strict tool is sent without strict", () => {
  const spec = { name: "x", description: "d", schema: { type: "object" }, strict: false };
  expect(anthropicTool(spec)).not.toHaveProperty("strict");
  expect(openaiTool(spec)).toMatchObject({ strict: false });
  expect(anthropicTool({ ...spec, strict: undefined })).toMatchObject({ strict: true });
});
