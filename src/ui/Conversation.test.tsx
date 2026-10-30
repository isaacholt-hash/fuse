import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Tooltip } from "radix-ui";
import { Composer, Messages } from "./Conversation";

afterEach(cleanup);

test("LL-01: an answer from a fixed rule says no model was asked, at $0", () => {
  render(
    <Tooltip.Provider>
      <Messages
        startedAt={0}
        onRetry={() => undefined}
        modelName="Auto"
        messages={[
          { id: "q", role: "user", content: "convert 5 km to miles", status: "complete" },
          {
            id: "a",
            role: "assistant",
            content: "5 km = 3.10685596119 mi",
            status: "complete",
            model: "No model",
            noModel: "Unit conversion",
          },
        ]}
      />
    </Tooltip.Provider>,
  );
  expect(screen.getByText("5 km = 3.10685596119 mi")).toBeTruthy();
  const badge = screen.getByRole("button", { name: "Answered without a model" });
  expect(badge.textContent).toBe("answered without a model·$0");
});

test("WF-02: a chat's folders show in the composer; its own can be removed, its project's can't", () => {
  const onAddFolder = vi.fn();
  const onRemoveFolder = vi.fn();
  const onToggleWork = vi.fn();
  const m = {
    id: "m",
    provider: "anthropic" as const,
    providerName: "Anthropic",
    name: "Claude",
    context: "200K",
    inputPrice: 1,
    outputPrice: 1,
  };
  render(
    <Tooltip.Provider>
      <Composer
        model={m}
        models={[m]}
        streaming={false}
        missingKey={null}
        pickerOpen={false}
        onPickerOpen={() => undefined}
        onSelectModel={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        onSettings={() => undefined}
        folders={[
          { id: "a", name: "notes", path: "/home/me/notes", own: true },
          { id: "b", name: "app", path: "/code/app", own: false },
        ]}
        onAddFolder={onAddFolder}
        onRemoveFolder={onRemoveFolder}
        code={false}
        onToggleCode={() => undefined}
        work
        onToggleWork={onToggleWork}
        codeMode="ask"
        onCodeMode={() => undefined}
      />
    </Tooltip.Provider>,
  );
  expect(screen.getByText("notes")).toBeTruthy();
  expect(screen.getByText("app")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove folder notes" }));
  expect(onRemoveFolder).toHaveBeenCalledWith("a");
  expect(screen.queryByRole("button", { name: "Remove folder app" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add a folder" }));
  expect(onAddFolder).toHaveBeenCalled();
  // WF-01: Work sits beside Code; with Work on, its permission mode can be picked.
  expect(screen.getByRole("button", { name: "Work run" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "Coding run" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(screen.getByLabelText("What the coding run may do")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Work run" }));
  expect(onToggleWork).toHaveBeenCalled();
});
