// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { sendMessage, regenerate } from "@/chat/sendMessage";
import { startChatRun } from "@/agent/chatRun";
import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { createThread } from "@/storage/threads";
import { listMessages } from "@/storage/messages";
import { openTestDb } from "@/storage/testing/nodeDb";
import { readSkillPackage } from "./package";
import { importSkill, deleteSkill } from "./storage";

const catalog = parseCatalog({
  price_version: "2026-11-05",
  models: [
    {
      provider: "openai",
      id: "fixture",
      display_name: "Recorded",
      context_window: 200000,
      max_output: 1000,
      price: { input: 1, output: 2 },
      capabilities: ["tools"],
      verified_on: "2026-11-05",
      source_url: "https://example.com/fixture",
    },
  ],
});
const model = catalog.models[0] as CatalogModel;
const repo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: () => Promise.reject(new Error("unused")),
  list: () => Promise.resolve([]),
  read: () => Promise.reject(new Error("no machine file access")),
  search: () => Promise.resolve([]),
  write: () => Promise.reject(new Error("no writes")),
  remove: () => Promise.reject(new Error("no writes")),
  move: () => Promise.reject(new Error("no writes")),
};

async function setup() {
  const db = openTestDb(),
    p = await createProject(db, tenant, "Skill fixture"),
    thread = await createThread(db, tenant, "Named skill", p.id);
  await setProjectRepo(db, tenant, p.id, { root: "/recorded", readSecrets: false });
  const version = await importSkill(db, tenant, {
    name: "notes",
    projectId: p.id,
    localOnly: false,
    package: await readSkillPackage(
      "notes.zip",
      zipSync({
        "SKILL.md": strToU8("Write a concise recorded summary."),
        "reference.txt": strToU8("Reference marker."),
      }),
    ),
  });
  const seen: { history: ChatMessage[]; options: ChatOptions }[] = [];
  let tool = false;
  const adapter: ProviderAdapter = {
    provider: "openai",
    listModels: () => Promise.resolve([]),
    async *streamChat(history, _m, options): AsyncGenerator<StreamEvent> {
      await Promise.resolve();
      seen.push({ history: structuredClone(history), options: structuredClone(options) });
      if (!tool) {
        tool = true;
        yield {
          type: "tool_call",
          call: {
            id: "recorded-read",
            name: "read_skill_file",
            input: { version_id: version.versionId, path: "reference.txt" },
          },
        };
      } else yield { type: "text", text: "Recorded summary complete." };
      yield {
        type: "done",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: "end_turn",
        providerRequestId: `fixture-${String(seen.length)}`,
        attempts: 1,
      };
    },
  };
  const deps = { db, tenant, catalog, adapterFor: () => adapter, repo, cache: false };
  return { db, p, thread, version, seen, deps };
}

test("normal Chat pins by name, supplies supporting data without a web adapter and retains the version on regenerate", async () => {
  const s = await setup();
  expect(s.seen).toEqual([]);
  const result = await sendMessage(s.deps, {
    threadId: s.thread.id,
    model,
    text: "/skill notes\n\nSummarize.",
  });
  expect(result.status).toBe("complete");
  expect(s.seen).toHaveLength(2);
  expect(s.seen[0]?.options.tools?.map((t) => t.name)).toEqual([
    "read_skill_file",
    "read_memory",
    "search_artifacts",
    "read_artifact",
    "propose_memory",
    "create_artifact",
    "update_artifact",
  ]);
  expect(s.seen[0]?.options.system).toContain("Write a concise recorded summary.");
  expect(s.seen[1]?.history.at(-1)?.toolResults?.[0]?.content).toContain("Reference marker.");
  const question = (await listMessages(s.db, tenant, s.thread.id)).find((m) => m.role === "user");
  expect(question?.content).toContain(`notes@${s.version.versionId}`);
  await importSkill(s.db, tenant, {
    name: "notes",
    projectId: s.p.id,
    localOnly: false,
    skillId: s.version.skillId,
    package: await readSkillPackage("SKILL.md", strToU8("Changed after dispatch.")),
  });
  const repeated = await regenerate(s.deps, {
    threadId: s.thread.id,
    model,
    answerId: result.assistantMessageId,
  });
  expect(s.seen.at(-1)?.options.system).toContain("Write a concise recorded summary.");
  expect(s.seen.at(-1)?.options.system).not.toContain("Changed after dispatch.");
  await deleteSkill(s.db, tenant, s.version.skillId);
  const calls = s.seen.length;
  await expect(
    regenerate(s.deps, { threadId: s.thread.id, model, answerId: repeated.assistantMessageId }),
  ).rejects.toThrow(/available/);
  expect(s.seen).toHaveLength(calls);
});

test("a read-only Code run preserves the pinned task, uses the same package and executes no scripts", async () => {
  const s = await setup();
  const run = await startChatRun(s.deps, {
    threadId: s.thread.id,
    projectId: s.p.id,
    task: "/skill notes\n\nInspect the summary.",
    model,
    mode: "plan",
    capMicroUsd: 100000,
  });
  expect(run.status).toBe("done");
  expect(run.task).toContain(`notes@${s.version.versionId}`);
  expect(s.seen[0]?.options.system).toContain("Packages confer no permissions");
  expect(
    s.seen[0]?.options.tools?.some((t) => t.name === "run_command" || t.name === "run_python"),
  ).toBe(false);
  expect(
    await s.db.select("SELECT id FROM run_changes UNION SELECT id FROM run_approvals"),
  ).toEqual([]);
});
