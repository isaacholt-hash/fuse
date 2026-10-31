import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Tooltip } from "radix-ui";
import { Composer } from "./Conversation";

// jsdom has no layout, so the row's widths are stubbed: everything in one row needs 700 px, with
// "More" 450 px, and with Search in "More" too 380 px.
let width = 0;
const content = (el: HTMLElement) =>
  !el.parentElement?.querySelector('[aria-label="More options"]')
    ? 700
    : el.querySelector('[aria-label="Search the web"]')
      ? 450
      : 380;
const row = (el: HTMLElement) => el.dataset.composerRow !== undefined;
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
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return row(this) ? width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return row(this) ? content(this) : 0;
    },
  });
});
afterAll(() => {
  if (!hadObserver) Reflect.deleteProperty(globalThis, "ResizeObserver");
  // Back to jsdom's own (0) for the other tests in this worker.
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
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

function show(at: number) {
  width = at;
  const onCodeBranch = vi.fn();
  const utils = render(
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
        folders={[{ id: "a", name: "lighthouse", path: "/home/me/lighthouse", own: true }]}
        onAddFolder={() => undefined}
        onRemoveFolder={() => undefined}
        code
        onToggleCode={() => undefined}
        work={false}
        onToggleWork={() => undefined}
        codeMode="ask"
        onCodeMode={() => undefined}
        codeBranch
        onCodeBranch={onCodeBranch}
        onToggleWebSearch={() => undefined}
        webSearch={false}
        compare={{
          options: [
            { key: "a", label: "Claude" },
            { key: "b", label: "GPT" },
          ],
          selected: [],
          onChange: () => undefined,
          estimate: () => null,
        }}
      />
    </Tooltip.Provider>,
  );
  return { ...utils, onCodeBranch };
}

/** The controls that stay in the row (Search too, unless the row is very narrow). */
function mainControls(search = true) {
  for (const name of [
    "Choose model (Ctrl+K)",
    ...(search ? ["Search the web"] : []),
    "Remove folder lighthouse",
    "Add a folder",
    "Coding run",
    "Work run",
    "Send message (Enter)",
  ]) {
    expect(screen.getByRole("button", { name })).toBeTruthy();
  }
}

test("F4: wide, everything fits in one row", () => {
  show(800);
  mainControls();
  expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
  expect(screen.getByRole("button", { name: "Think harder" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Compare models" })).toBeTruthy();
  expect(screen.getByLabelText("New branch")).toBeTruthy();
  expect(screen.getByLabelText("What the coding run may do")).toBeTruthy();
});

for (const at of [600, 400]) {
  test(`F4: at ${String(at)} px, run mode, New branch, Think and Compare move into More`, () => {
    const { onCodeBranch } = show(at);
    mainControls(at > 450);
    expect(screen.queryByRole("button", { name: "Think harder" })).toBeNull();
    expect(screen.queryByLabelText("New branch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const more = within(screen.getByRole("dialog", { name: "More options" }));
    // Each shows its state there.
    expect(more.getByLabelText<HTMLSelectElement>("What the coding run may do").value).toBe("ask");
    expect(more.getByLabelText<HTMLInputElement>("New branch").checked).toBe(true);
    fireEvent.click(more.getByLabelText("New branch"));
    expect(onCodeBranch).toHaveBeenCalledWith(false);
    const think = more.getByRole("button", { name: "Think harder" });
    expect(think.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(think);
    expect(think.getAttribute("aria-pressed")).toBe("true");
    expect(think.textContent).toContain("on");
    expect(more.getByRole("group", { name: "Models to compare" })).toBeTruthy();
  });
}

test("F4: very narrow, Search moves into More as well, and shows its state there", () => {
  show(400);
  expect(screen.queryByRole("button", { name: "Search the web" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  const more = within(screen.getByRole("dialog", { name: "More options" }));
  expect(more.getByRole("button", { name: "Search the web" }).textContent).toBe("Search the web");
});
