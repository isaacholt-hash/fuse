// M10 step 26: the composer row is "+", the model, Options and Send; what's on shows as a chip.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Tooltip } from "radix-ui";
import type { ComponentProps } from "react";
import { Composer } from "./Conversation";

const hadObserver = "ResizeObserver" in globalThis;
beforeAll(() => {
  // jsdom has none; Radix's popover measures with one.
  if (!hadObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});
afterAll(() => {
  if (!hadObserver) Reflect.deleteProperty(globalThis, "ResizeObserver");
});
afterEach(cleanup);

const m = {
  id: "m",
  provider: "anthropic" as const,
  providerName: "Anthropic",
  name: "Claude",
  context: "200K",
  inputPrice: 1,
  outputPrice: 1,
};

function show(over: Partial<ComponentProps<typeof Composer>> = {}) {
  const props = {
    onCodeBranch: vi.fn(),
    onToggleWebSearch: vi.fn(),
    onAddFolder: vi.fn(),
    onCompare: vi.fn(),
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
        effortFor={() => ({
          auto: "medium",
          options: ["low", "medium", "high"],
          extraMicro: (l) => (l === "high" ? 4000 : l === "low" ? -2000 : 0),
        })}
        onStop={() => undefined}
        onSettings={() => undefined}
        onAddFiles={() => undefined}
        folders={[{ id: "a", name: "lighthouse", path: "/home/me/lighthouse", own: true }]}
        onAddFolder={props.onAddFolder}
        onRemoveFolder={() => undefined}
        code
        onToggleCode={() => undefined}
        work={false}
        onToggleWork={() => undefined}
        codeMode="ask"
        onCodeMode={() => undefined}
        codeBranch
        onCodeBranch={props.onCodeBranch}
        onToggleWebSearch={props.onToggleWebSearch}
        webSearch={false}
        compare={{
          options: [
            { key: "a", label: "Claude" },
            { key: "b", label: "GPT" },
          ],
          selected: [],
          onChange: props.onCompare,
          estimate: () => null,
        }}
        estimate={() => 8000}
        {...over}
      />
    </Tooltip.Provider>,
  );
  return props;
}

test("the row: +, the model, Options, the folder, the estimate and Send; nothing else", () => {
  show();
  const row = document.querySelector<HTMLElement>("[data-composer-row]");
  if (!row) throw new Error("no row");
  const names = within(row)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"));
  expect(names).toEqual(["Add", null, "Options", "Remove folder lighthouse"]);
  expect(within(row).getAllByRole("button")[1]?.textContent).toMatch(/, choose model \(Ctrl\+K\)$/);
  expect(screen.getByRole("button", { name: "Send message (Enter)" })).toBeTruthy();
  // The estimate is muted in the margin beside the composer, labelled, not copper.
  const est = screen.getByLabelText("Estimated cost");
  expect(est.textContent).toBe("next message ≈ $0.008");
  expect(est.className).toContain("text-muted-foreground");
  // No persistent privacy or keyboard lines.
  expect(screen.queryByText(/Your keys/)).toBeNull();
  expect(screen.queryByText(/Enter to send/)).toBeNull();
});

test("while a run goes, the estimate gives way to what it has spent; a plain chat shows neither", () => {
  show({ streaming: true, spentSoFar: 1100 });
  expect(screen.getByLabelText("Estimated cost").textContent).toBe("so far $0.0011");
});

test("while a plain chat answer streams, no estimate shows", () => {
  show({ streaming: true });
  expect(screen.queryByLabelText("Estimated cost")).toBeNull();
});

test("+ holds attaching files and adding a folder", () => {
  const p = show();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const add = within(screen.getByRole("dialog", { name: "Add" }));
  expect(add.getByRole("button", { name: "Attach a file" })).toBeTruthy();
  fireEvent.click(add.getByRole("button", { name: "Add a folder" }));
  expect(p.onAddFolder).toHaveBeenCalled();
});

test("Options: kind, mode, branch, web search and compare, each with its state", () => {
  const p = show();
  fireEvent.click(screen.getByRole("button", { name: "Options" }));
  const options = within(screen.getByRole("dialog", { name: "Options" }));
  expect(options.getByRole("button", { name: "Coding run" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(options.getByLabelText<HTMLSelectElement>("What the coding run may do").value).toBe("ask");
  expect(options.getByLabelText<HTMLInputElement>("New branch").checked).toBe(true);
  fireEvent.click(options.getByLabelText("New branch"));
  expect(p.onCodeBranch).toHaveBeenCalledWith(false);
  const search = options.getByRole("button", { name: "Search the web" });
  expect(search).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(search);
  expect(p.onToggleWebSearch).toHaveBeenCalled();
  expect(options.getByRole("group", { name: "Models to compare" })).toBeTruthy();
});

test("a mode that's on shows as a chip, and its × turns it off", () => {
  const p = show({
    webSearch: true,
    compare: {
      options: [
        { key: "a", label: "Claude" },
        { key: "b", label: "GPT" },
      ],
      selected: ["a", "b"],
      onChange: vi.fn(),
      estimate: () => "about $0.02",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Turn off web search" }));
  expect(p.onToggleWebSearch).toHaveBeenCalled();
  expect(screen.getByText("Compare · 2")).toBeTruthy();
  expect(screen.getByLabelText("Compare cost").textContent).toContain("Sends to 2 models");
});

test("effort is in the model menu; a chosen level shows on the model chip", () => {
  show({ pickerOpen: true });
  const effort = within(screen.getByRole("group", { name: "Reasoning effort" }));
  expect(effort.getByRole("radio", { name: "Usual" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(effort.getByRole("radio", { name: /High/ }));
  expect(screen.getByRole("button", { name: /choose model \(Ctrl\+K\)$/ }).textContent).toContain(
    "· High",
  );
});

test("the estimate turns to warning only when it's over the cap left", () => {
  show({ capLeft: 5000 });
  expect(screen.getByLabelText("Estimated cost").className).toContain("text-warning");
  cleanup();
  show({ capLeft: 900_000 });
  expect(screen.getByLabelText("Estimated cost").className).toContain("text-muted-foreground");
});

test("a guide holds Send and says what to do, quietly", () => {
  show({ guide: "Choose a project to start." });
  expect(screen.getByRole("note").textContent).toBe("Choose a project to start.");
  expect(screen.getByRole("button", { name: "Send message (Enter)" })).toBeDisabled();
});
