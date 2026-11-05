import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createProject } from "@/storage/projects";
import { createThread } from "@/storage/threads";
import { setSetting } from "@/storage/settings";
import { addMemory } from "@/storage/memories";
import { listArtifacts, listVersions } from "@/storage/artifacts";
import { listRecentRequests } from "@/storage/requestLog";
import { fakeKeysApi } from "@/test/fakeKeysApi";
import { memoryFilesApi } from "@/files/api";
import type { RepoApi } from "@/repo/api";
import type { HulkApi } from "@/handover/api";
import { scriptedResearchAdapter, scriptedResearchWeb } from "@/research/testing/scripted";

vi.setConfig({ testTimeout: 20_000 });
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const noHulk: HulkApi = {
  status: () =>
    Promise.resolve({ address: null, paired: false, mine: null, server: null, mismatch: null }),
  pair: () => Promise.reject(new Error("unused")),
  unpair: () => Promise.reject(new Error("unused")),
  invoke: () => Promise.reject(new Error("unused")),
  putFile: () => Promise.reject(new Error("Research never exports the project")),
};
test("Chat research preserves its project/draft, requires a cap, pauses and explicitly resumes without Code access", async () => {
  localStorage.clear();
  const db = openTestDb(),
    project = await createProject(db, tenant, "Research project"),
    thread = await createThread(db, tenant, "Research source", project.id);
  const memory = await addMemory(db, tenant, {
    text: "SELECTED RESEARCH CONTEXT",
    kind: "fact",
    projectId: project.id,
  });
  await addMemory(db, tenant, {
    text: "UNSELECTED RESEARCH CONTEXT",
    kind: "fact",
    projectId: project.id,
  });
  await setSetting(db, tenant, "memory.suggest", "off");
  localStorage.setItem("fuse.lastThread.chat", thread.id);
  const keys = fakeKeysApi();
  keys.keys.set("openai", "fixture-unused");
  keys.keys.set("anthropic", "fixture-unused");
  const sent: string[] = [];
  const repo = new Proxy({} as RepoApi, {
    get() {
      throw new Error("Research must not touch a repository");
    },
  });
  render(
    <App
      openDb={() => Promise.resolve(db)}
      appBuild={() => Promise.resolve(null)}
      keysApi={keys.api}
      files={memoryFilesApi()}
      repo={repo}
      hulk={noHulk}
      web={scriptedResearchWeb()}
      adapterFor={(provider) =>
        scriptedResearchAdapter(provider, {
          delayMs: 700,
          onCall: (_model, messages, system) => {
            sent.push(JSON.stringify({ messages, system }));
          },
        })
      }
      preview={{ url: () => Promise.resolve("about:blank") }}
      backups={{
        list: () => Promise.resolve([]),
        backupNow: () => Promise.reject(new Error("unused")),
        restore: () => Promise.reject(new Error("unused")),
        checkFiles: () => Promise.reject(new Error("unused")),
        sizes: () =>
          Promise.resolve({
            databaseBytes: 0,
            backupCount: 0,
            backupBytes: 0,
            attachmentCount: 0,
            attachmentBytes: 0,
          }),
        pruneBackups: () => Promise.resolve(0),
        pruneFiles: () => Promise.resolve(0),
      }}
    />,
  );
  const user = userEvent.setup();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await user.type(composer, "Keep this draft");
  await user.click(screen.getByRole("button", { name: "Options" }));
  await user.click(screen.getByRole("button", { name: "Research" }));
  let dialog = within(await screen.findByRole("dialog", { name: "Research" }));
  expect(dialog.getByLabelText("Research spending cap (USD)")).toHaveValue("");
  expect(dialog.getByRole("button", { name: "Start research" })).toBeDisabled();
  expect(sent).toEqual([]);
  expect(await db.select("SELECT id FROM runs")).toEqual([]);
  await user.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(composer).toHaveValue("Keep this draft");
  await user.click(screen.getByRole("button", { name: "Options" }));
  await user.click(screen.getByRole("button", { name: "Research" }));
  dialog = within(await screen.findByRole("dialog", { name: "Research" }));
  expect(dialog.getByLabelText("Research spending cap (USD)")).toHaveValue("");
  fireEvent.change(dialog.getByLabelText("Research scope"), {
    target: { value: "E2E research measurements" },
  });
  await user.click(dialog.getByLabelText("fact: SELECTED RESEARCH CONTEXT"));
  await user.type(dialog.getByLabelText("Research spending cap (USD)"), "5");
  await user.click(dialog.getByRole("button", { name: "Start research" }));
  const pause = await screen.findByRole("button", { name: "Pause research" }, { timeout: 5000 });
  await user.click(pause);
  const continueButton = await screen.findByRole(
    "button",
    { name: "Continue research" },
    { timeout: 6000 },
  );
  expect(sent.length).toBeLessThan(4);
  await user.click(continueButton);
  const resume = within(await screen.findByRole("dialog", { name: "Continue research" }));
  fireEvent.change(resume.getByLabelText("Continue research total cap (USD)"), {
    target: { value: "5.50" },
  });
  await user.click(resume.getByRole("button", { name: "Continue research" }));
  await waitFor(
    async () => {
      expect(await db.select("SELECT status,project_id,cap_micro_usd FROM runs")).toEqual([
        { status: "done", project_id: project.id, cap_micro_usd: 5_500_000 },
      ]);
    },
    { timeout: 8000 },
  );
  expect(sent).toHaveLength(4);
  expect(sent.join("\n")).toContain("SELECTED RESEARCH CONTEXT");
  expect(sent.join("\n")).not.toContain("UNSELECTED RESEARCH CONTEXT");
  const report = (await listArtifacts(db, tenant, thread.id))[0];
  expect(report?.content).toContain("[S1](https://research-fixture.example/source)");
  expect(await listVersions(db, tenant, report?.id ?? "")).toHaveLength(2);
  expect(await listRecentRequests(db, tenant)).toHaveLength(4);
  expect(await db.select("SELECT id FROM folders")).toEqual([]);
  expect(await db.select("SELECT id FROM run_changes")).toEqual([]);
  expect(await db.select("SELECT id FROM memories WHERE id=?", [memory])).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this draft");
});
