// M10 step 16: a session's Files panel.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilesPanel } from "./FilesPanel";
import type { RunChangeView } from "./types";

afterEach(cleanup);

const change = (over: Partial<RunChangeView>): RunChangeView => ({
  id: "c1",
  label: "Edited src/tide.ts",
  added: 1,
  removed: 1,
  lines: [],
  undone: false,
  previewable: true,
  ...over,
});

test("changed files from every run, with Undo and Preview; undone ones are struck; artifacts open", () => {
  const onUndo = vi.fn();
  const onPreview = vi.fn();
  const onOpenArtifact = vi.fn();
  render(
    <FilesPanel
      changes={[change({}), change({ id: "c2", label: "Created notes.md", undone: true })]}
      artifacts={[{ key: "a1", title: "Release notes" }]}
      busy={false}
      onUndo={onUndo}
      onPreview={onPreview}
      onOpenArtifact={onOpenArtifact}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Undo Edited src/tide.ts" }));
  expect(onUndo).toHaveBeenCalledWith("c1");
  fireEvent.click(screen.getByRole("button", { name: "Preview Edited src/tide.ts" }));
  expect(onPreview).toHaveBeenCalledWith("c1");
  expect(screen.queryByRole("button", { name: "Undo Created notes.md" })).toBeNull();
  expect(screen.getByText("Created notes.md").closest("li")?.className).toMatch(/line-through/);
  fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
  expect(onOpenArtifact).toHaveBeenCalledWith("a1");
});
