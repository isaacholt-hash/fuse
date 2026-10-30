import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Tooltip } from "radix-ui";
import { Messages } from "./Conversation";
import { FileViewer } from "./FileViewer";
import type { RunView } from "./types";

afterEach(cleanup);

test("WF-05: a Word or Excel file previews as text and tables, with open and show buttons", () => {
  const onOpen = vi.fn();
  const onReveal = vi.fn();
  render(
    <FileViewer
      file={{
        name: "budget.xlsx",
        kind: "document",
        markdown: "## Costs\n\n| | A | B |\n|---|---|---|\n| 1 | Rent | 1200 |",
        onOpen,
        onReveal,
      }}
      onClose={() => undefined}
    />,
  );
  expect(screen.getByRole("heading", { name: "Costs" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Rent" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open in its app" }));
  fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
  expect(onOpen).toHaveBeenCalled();
  expect(onReveal).toHaveBeenCalled();
});

test("WF-05: each file a run made has Preview; a deleted or undone one doesn't", () => {
  const onPreviewChange = vi.fn();
  const run: RunView = {
    id: "r1",
    title: "Work run",
    status: "done",
    costLabel: "$0.01 of $1.00",
    note: null,
    steps: [],
    streaming: "",
    modeLabel: "can edit files",
    branch: null,
    changes: [
      {
        id: "c1",
        label: "Created summary.docx",
        added: 3,
        removed: 0,
        lines: [],
        undone: false,
        previewable: true,
      },
      {
        id: "c2",
        label: "Deleted old.md",
        added: 0,
        removed: 2,
        lines: [],
        undone: false,
        previewable: false,
      },
    ],
  };
  render(
    <Tooltip.Provider>
      <Messages
        modelName="Auto"
        startedAt={0}
        onRetry={() => undefined}
        onPreviewChange={onPreviewChange}
        messages={[
          { id: "q", role: "user", content: "Summarise", status: "complete" },
          { id: "a", role: "assistant", content: "Done.", status: "complete", run },
        ]}
      />
    </Tooltip.Provider>,
  );
  const previews = screen.getAllByRole("button", { name: "Preview" });
  expect(previews).toHaveLength(1);
  fireEvent.click(previews[0] as HTMLElement);
  expect(onPreviewChange).toHaveBeenCalledWith("c1");
});
