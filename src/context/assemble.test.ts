// @vitest-environment node
// PM-18: what each request carries. The first snapshot was recorded before the context assembler
// existed, so a chat without decisions, constraints or tasks must still send exactly the same.
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { sendMessage, type ChatDeps } from "@/chat/sendMessage";
import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from "@/providers/types";
import { saveArtifacts, addVersion, listArtifacts } from "@/storage/artifacts";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { setGlobalInstructions } from "@/storage/instructions";
import { addDecision, addMemory, addTask } from "@/storage/memories";
import { listPath } from "@/storage/messages";
import { createProject, setProjectRepo, updateProject } from "@/storage/projects";
import type { RepoApi } from "@/repo/api";
import { addSummary } from "@/storage/summaries";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, setThreadInstructions, setThreadProject } from "@/storage/threads";
import { assemble } from "./assemble";
import { gatherContext } from "./gather";

const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-10-26",
  models: [
    {
      provider: "anthropic",
      id: "test-claude",
      display_name: "Test Claude",
      context_window: 200000,
      max_output: 1000,
      price: { input: 2, output: 10 },
      capabilities: [],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
  ],
});
const claude = catalog.models[0] as CatalogModel;

async function* answer(text: string): AsyncGenerator<StreamEvent> {
  await Promise.resolve();
  yield { type: "text", text };
  yield {
    type: "done",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webSearchCalls: 0,
    },
    usageReported: true,
    stopReason: "end_turn",
    providerRequestId: "req_x",
    attempts: 1,
  };
}

/** A project chat with instructions at every level, memories, a summary and an edited artifact. */
async function richChat() {
  const db = openTestDb();
  const sent: { history: ChatMessage[]; options: ChatOptions }[] = [];
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    streamChat(history, _model, options) {
      sent.push({ history: structuredClone(history), options: structuredClone(options) });
      return answer("Noted.");
    },
  };
  const deps: ChatDeps = { db, tenant: t, catalog, adapterFor: () => adapter };
  await setGlobalInstructions(db, t, { aboutYou: "I live in Leeds.", howToAnswer: "Be brief." });
  const project = await createProject(db, t, "Kitchen");
  await updateProject(db, t, project.id, {
    name: "Kitchen",
    instructions: "Prices in GBP.",
    defaultModel: null,
  });
  const thread = await createThread(db, t);
  await setThreadProject(db, t, thread.id, project.id);
  await setThreadInstructions(db, t, thread.id, "Metric units.");
  await addMemory(db, t, { text: "Has a dog called Biscuit.", kind: "fact" });
  await addMemory(db, t, {
    text: "Likes Shaker-style doors.",
    kind: "preference",
    projectId: project.id,
  });
  const send = (text: string) => sendMessage(deps, { threadId: thread.id, text, model: claude });
  await send("Plan the kitchen.");
  const { path } = await listPath(db, t, thread.id);
  await addSummary(db, t, thread.id, path.at(-1)?.id ?? "", "They want a new kitchen.");
  await saveArtifacts(db, t, thread.id, path.at(-1)?.id ?? "", [
    {
      key: "plan",
      title: "Plan",
      type: "markdown",
      language: "",
      content: "1. Measure",
      complete: true,
    },
  ]);
  const [plan] = await listArtifacts(db, t, thread.id);
  await addVersion(db, t, plan?.id ?? "", "1. Measure\n2. Order", "user");
  return { db, deps, project, thread, send, sent };
}

test("a chat without decisions, constraints or tasks sends what it did before the assembler", async () => {
  const { send, sent, thread } = await richChat();
  await send("What next?");
  const last = sent.at(-1);
  // The scope for the Rust egress check (SE-13, added after the snapshot) isn't prompt content.
  expect(last?.options.scope).toEqual({ kind: "thread", id: thread.id });
  delete last?.options.scope;
  expect(last).toMatchSnapshot();
});

test("decisions and constraints, then tasks, then memories, each part with its source (PM-18)", async () => {
  const { db, deps, project, thread, send, sent } = await richChat();
  const oak = await addDecision(db, t, project.id, {
    text: "Oak worktops.",
    rationale: "They last.",
    alternatives: ["Laminate"],
  });
  await addMemory(db, t, { text: "Budget is £8,000.", kind: "constraint", projectId: project.id });
  const order = await addTask(db, t, project.id, "Order samples");
  await send("What next?");
  const system = sent.at(-1)?.options.system ?? "";
  const at = (text: string) => system.indexOf(text);
  expect(at("<this_chat>")).toBeLessThan(at("<decisions_and_constraints>"));
  expect(at("- Decision: Oak worktops. Reason: They last. Ruled out: Laminate")).toBeLessThan(
    at("<open_tasks>"),
  );
  expect(at("- Constraint: Budget is £8,000.")).toBeLessThan(at("<open_tasks>"));
  expect(at("- Task (to do): Order samples")).toBeLessThan(at("<memories>"));
  expect(at("- Has a dog called Biscuit.")).toBeLessThan(at("<earlier_conversation>"));
  expect(at("<earlier_conversation>")).toBeLessThan(at("<edited_artifacts>"));

  const { history } = await gatherContext(
    deps,
    thread.id,
    (await listPath(db, t, thread.id)).path.slice(0, -1),
    null,
  );
  const pkg = await assemble(
    deps,
    thread.id,
    { history, earlier: "Before.", fileSources: [] },
    null,
  );
  expect(pkg.parts.map((p) => p.kind)).toEqual([
    "guide",
    "instructions",
    "decisions",
    "tasks",
    "memories",
    "summary",
    "artifacts",
    "history",
  ]);
  expect(pkg.parts.find((p) => p.kind === "instructions")?.sources).toEqual([
    "about_you",
    "how_to_answer",
    "project",
    "thread",
  ]);
  expect(pkg.parts.find((p) => p.kind === "decisions")?.sources).toContain(oak);
  expect(pkg.parts.find((p) => p.kind === "tasks")?.sources).toEqual([order]);
  expect(pkg.picked.find((p) => p.memory.id === oak)?.reason).toBe("always");
});

test("CA-06: a linked repository's CLAUDE.md and AGENTS.md go in, between project and chat", async () => {
  const { db, deps, project, thread, sent } = await richChat();
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const files: Record<string, string> = {
    "CLAUDE.md": "Use pnpm.",
    "AGENTS.md": "Run pnpm check.",
  };
  const repo: RepoApi = {
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("unused")),
    list: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
    read: (_p, path) => {
      const content = files[path];
      return content === undefined
        ? Promise.reject(new Error("no such file"))
        : Promise.resolve({
            path,
            content,
            offset: 0,
            totalBytes: content.length,
            truncated: false,
          });
    },
  };
  await sendMessage({ ...deps, repo }, { threadId: thread.id, text: "Go on.", model: claude });
  const system = sent.at(-1)?.options.system ?? "";
  const at = (s: string) => system.indexOf(s);
  expect(at('<repository_file path="CLAUDE.md">\nUse pnpm.\n</repository_file>')).toBeGreaterThan(
    -1,
  );
  expect(at('<repository_file path="AGENTS.md">')).toBeGreaterThan(at('path="CLAUDE.md"'));
  expect(at("Prices in GBP.")).toBeLessThan(at("Use pnpm."));
  expect(at("Metric units.")).toBeGreaterThan(at("Run pnpm check."));
  const ctx = await gatherContext(deps, thread.id, (await listPath(db, t, thread.id)).path, null);
  const pkg = await assemble({ ...deps, repo }, thread.id, ctx, null);
  expect(pkg.parts.find((p) => p.kind === "instructions")?.sources).toEqual([
    "about_you",
    "how_to_answer",
    "project",
    "repo:CLAUDE.md",
    "repo:AGENTS.md",
    "thread",
  ]);
  // Without the repository API (or a linked folder) nothing changes.
  const plain = await assemble(deps, thread.id, ctx, null);
  expect(plain.system).not.toContain("repository_file");
});
