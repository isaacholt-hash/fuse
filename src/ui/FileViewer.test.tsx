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
    activeSince: null,
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

test("WF-06: a plan to approve: every move ticked, allow all, allow some, or deny", () => {
  const onApprove = vi.fn();
  const run: RunView = {
    id: "r2",
    title: "Work run",
    status: "running",
    costLabel: "$0.01 of $1.00",
    activeSince: null,
    note: null,
    steps: [],
    streaming: "",
    modeLabel: "can edit files",
    branch: null,
    changes: [],
    approval: {
      kind: "organise",
      reason: "Photos together",
      moves: [
        { from: "IMG_1.jpg", to: "Photos/IMG_1.jpg" },
        { from: "taxes.pdf", to: "Papers/taxes.pdf" },
      ],
    },
  };
  render(
    <Tooltip.Provider>
      <Messages
        modelName="Auto"
        startedAt={0}
        onRetry={() => undefined}
        onApprove={onApprove}
        messages={[
          { id: "q", role: "user", content: "Tidy", status: "complete" },
          { id: "a", role: "assistant", content: "", status: "streaming", run },
        ]}
      />
    </Tooltip.Provider>,
  );
  expect(screen.getByText(/Into: Papers, Photos/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /ticked/ })).toBeNull();
  fireEvent.click(screen.getByLabelText("Move taxes.pdf to Papers/taxes.pdf"));
  fireEvent.click(screen.getByRole("button", { name: "Allow 1 ticked" }));
  expect(onApprove).toHaveBeenCalledWith("r2", { keep: [0] });
  fireEvent.click(screen.getByRole("button", { name: "Allow all" }));
  expect(onApprove).toHaveBeenLastCalledWith("r2", "yes");
});
