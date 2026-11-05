import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillsSection } from "./Skills";
import { Composer } from "./Conversation";
import { Tooltip } from "radix-ui";

afterEach(cleanup);
const versionId = "00000000-0000-7000-8000-000000000123";

test("package selection previews before import, records scope and never auto-imports", async () => {
  const onImport = vi.fn((_input: import("./Skills").SkillImport) => Promise.resolve()),
    onDelete = vi.fn(() => Promise.resolve());
  render(
    <SkillsSection
      skills={[]}
      projects={[{ id: "p", name: "Notes" }]}
      onImport={onImport}
      onDelete={onDelete}
    />,
  );
  fireEvent.change(screen.getByLabelText("Skill name"), { target: { value: "notes" } });
  fireEvent.change(screen.getByLabelText("Skill scope"), { target: { value: "p" } });
  const bytes = new TextEncoder().encode("Write reviewed notes.");
  const file = new File([bytes], "SKILL.md", { type: "text/markdown" });
  Object.defineProperty(file, "arrayBuffer", { value: () => Promise.resolve(bytes.buffer) });
  fireEvent.change(screen.getByLabelText("Choose skill package"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByLabelText("Skill import preview")).toBeVisible());
  expect(onImport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
  await waitFor(() => {
    expect(onImport).toHaveBeenCalledOnce();
  });
  expect(onImport.mock.calls[0]?.[0]).toMatchObject({
    name: "notes",
    projectId: "p",
    localOnly: false,
  });
});

test("skill deletion needs explicit confirmation", () => {
  const onDelete = vi.fn(() => Promise.resolve());
  render(
    <SkillsSection
      skills={[
        {
          id: "s",
          name: "notes",
          projectId: null,
          localOnly: false,
          versionId,
          versions: 1,
          sha256: "a".repeat(64),
          source: "SKILL.md",
          createdAt: 1,
        },
      ]}
      projects={[]}
      onImport={() => Promise.resolve()}
      onDelete={onDelete}
    />,
  );
  fireEvent.click(screen.getByLabelText("Delete skill notes"));
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete package" }));
  expect(onDelete).toHaveBeenCalledWith("s");
});

test("slash selection and palette insertion retain an editable draft and never send", async () => {
  const onSend = vi.fn(),
    onPickSkill = vi.fn();
  const props = {
    model: {
      id: "m",
      provider: "openai" as const,
      providerName: "OpenAI",
      name: "Recorded",
      context: "1K",
      inputPrice: 1,
      outputPrice: 2,
    },
    models: [],
    streaming: false,
    missingKey: null,
    pickerOpen: false,
    onPickerOpen: () => undefined,
    onSelectModel: () => undefined,
    onSend,
    onStop: () => undefined,
    onSettings: () => undefined,
    skills: [{ name: "notes", versionId }],
    onPickSkill,
  };
  const view = render(
    <Tooltip.Provider>
      <Composer {...props} />
    </Tooltip.Provider>,
  );
  const field = screen.getByLabelText("Message");
  fireEvent.change(field, { target: { value: "/skill not" } });
  expect(screen.getByRole("listbox", { name: "Named skills" })).toBeVisible();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onPickSkill).toHaveBeenCalledWith(versionId);
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: "Keep my draft." } });
  const insert = { key: 1, text: `/skill notes@${versionId}`, prepend: true };
  view.rerender(
    <Tooltip.Provider>
      <Composer {...props} insert={insert} />
    </Tooltip.Provider>,
  );
  await waitFor(() => expect(field).toHaveValue(`${insert.text}\nKeep my draft.`));
  view.rerender(
    <Tooltip.Provider>
      <Composer {...props} insert={{ ...insert, key: 2 }} />
    </Tooltip.Provider>,
  );
  expect(field).toHaveValue(`${insert.text}\nKeep my draft.`);
  expect(onSend).not.toHaveBeenCalled();
});
