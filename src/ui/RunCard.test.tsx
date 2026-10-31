import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Tooltip } from "radix-ui";
import { Messages } from "./Conversation";
import type { RunView } from "./types";

afterEach(cleanup);

const base: RunView = {
  id: "r1",
  title: "Work run",
  status: "running",
  costLabel: "$0.01 of $1.00",
  note: null,
  steps: [],
  streaming: "",
  modeLabel: "can edit files",
  branch: null,
  changes: [],
};

function show(run: RunView, onApprove = vi.fn()) {
  render(
    <Tooltip.Provider>
      <Messages
        modelName="Auto"
        startedAt={0}
        onRetry={() => undefined}
        onApprove={onApprove}
        messages={[
          { id: "q", role: "user", content: "Go", status: "complete" },
          { id: "a", role: "assistant", content: "", status: "streaming", run },
        ]}
      />
    </Tooltip.Provider>,
  );
}

test("F2: a command's row opens its whole result", () => {
  const output =
    "$ ping -n 1 127.0.0.1\nUnable to contact IP driver.\n[exit code 1, 0.1 s]\n[sandboxed, network off]";
  show({
    ...base,
    steps: [
      {
        id: "s1",
        kind: "tool",
        label: "Ran ping -n 1 127.0.0.1",
        error: "Unable to contact IP driver.",
        output,
      },
      { id: "s2", kind: "tool", label: "Read notes.md", error: null },
    ],
  });
  expect(screen.queryByLabelText("Output of Ran ping -n 1 127.0.0.1")).toBeNull();
  // Only commands open; other tools stay plain lines.
  expect(screen.queryByRole("button", { name: "Read notes.md" })).toBeNull();
  const row = screen.getByRole("button", { name: "Ran ping -n 1 127.0.0.1" });
  fireEvent.click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByLabelText("Output of Ran ping -n 1 127.0.0.1").textContent).toBe(output);
  fireEvent.click(row);
  expect(screen.queryByLabelText("Output of Ran ping -n 1 127.0.0.1")).toBeNull();
});

test("F2: 'Always allow in this project' is offered only in a project", () => {
  const approval = { kind: "command" as const, command: "echo hi", destructive: null };
  show({ ...base, approval, inProject: false });
  expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Always allow in this project" })).toBeNull();
  cleanup();
  const onApprove = vi.fn();
  show({ ...base, approval, inProject: true }, onApprove);
  fireEvent.click(screen.getByRole("button", { name: "Always allow in this project" }));
  expect(onApprove).toHaveBeenCalledWith("r1", "always");
});
