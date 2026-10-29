// @vitest-environment node
import { DEFAULT_TENANT } from "./defaults";
import { createProject, deleteProject } from "./projects";
import { deletePrompt, fillPrompt, listPrompts, promptVariables, savePrompt } from "./prompts";
import { openTestDb } from "./testing/nodeDb";

const t = DEFAULT_TENANT;

test("variables are found once each, in order, and filled; unknown ones stay", () => {
  const body = "Summarize for {{ audience }} in {{count}} bullets. Keep {{audience}} in mind.";
  expect(promptVariables(body)).toEqual(["audience", "count"]);
  expect(fillPrompt(body, { audience: "my boss" })).toBe(
    "Summarize for my boss in {{count}} bullets. Keep my boss in mind.",
  );
});

test("prompts are saved, edited, listed by name, and a deleted project's move to every chat", async () => {
  const db = openTestDb();
  const project = await createProject(db, t, "Garden");
  const id = await savePrompt(db, t, { name: "zeta", body: "z", projectId: project.id });
  await savePrompt(db, t, { name: "Alpha", body: "a", projectId: null });
  await savePrompt(db, t, { id, name: "Beta", body: "b2", projectId: project.id });
  expect((await listPrompts(db, t)).map((p) => [p.name, p.body, p.projectId])).toEqual([
    ["Alpha", "a", null],
    ["Beta", "b2", project.id],
  ]);
  await deleteProject(db, t, project.id);
  expect((await listPrompts(db, t)).map((p) => p.projectId)).toEqual([null, null]);
  await deletePrompt(db, t, id);
  expect(await listPrompts(db, t)).toHaveLength(1);
});
