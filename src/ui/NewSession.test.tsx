// M10 step 16: the new-session bar; step 26: project first, a location menu and Run settings.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NewSessionBar } from "./NewSession";

afterEach(cleanup);

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

function show(over: Partial<Parameters<typeof NewSessionBar>[0]> = {}) {
  const props = {
    projects: [{ id: "p1", name: "Lighthouse" }],
    projectId: null,
    onProject: vi.fn(),
    where: "local" as const,
    onWhere: vi.fn(),
    whereReasons: { local: null, hulk: "Pair with HULK in Settings first" },
    onOpenHulkSettings: vi.fn(),
    capMicroUsd: null,
    defaultCapMicroUsd: 1_000_000,
    onCap: vi.fn(),
    ...over,
  };
  render(<NewSessionBar {...props} />);
  return props;
}

test("project first, then where it runs, then Run settings", () => {
  const p = show();
  const order = [
    screen.getByLabelText("Project or repository"),
    screen.getByRole("button", { name: "Where it runs: This computer" }),
    screen.getByRole("button", { name: "Run settings" }),
  ];
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1] as Node;
    const b = order[i] as Node;
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  // No project yet: the select says what to do, not an error.
  const project = screen.getByLabelText<HTMLSelectElement>("Project or repository");
  expect(project.selectedOptions[0]?.textContent).toBe("Choose project");
  fireEvent.change(project, { target: { value: "p1" } });
  expect(p.onProject).toHaveBeenCalledWith("p1");
});

test("the location menu keeps HULK visible, greyed with why and a way to pair", () => {
  const p = show();
  // The pairing note lives in the menu, not on its own line.
  expect(screen.queryByText("Pair with HULK in Settings first")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Where it runs: This computer" }));
  const menu = within(screen.getByRole("group", { name: "Where it runs" }));
  expect(menu.getByRole("button", { name: "This computer" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(menu.getByRole("button", { name: "HULK" })).toBeDisabled();
  expect(menu.getByText(/Pair with HULK in Settings first/)).toBeInTheDocument();
  fireEvent.click(menu.getByRole("button", { name: "Open Settings" }));
  expect(p.onOpenHulkSettings).toHaveBeenCalled();
});

test("picking HULK when it can run there", () => {
  const p = show({ whereReasons: { local: null, hulk: null } });
  fireEvent.click(screen.getByRole("button", { name: "Where it runs: This computer" }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Where it runs" })).getByRole("button", {
      name: "HULK",
    }),
  );
  expect(p.onWhere).toHaveBeenCalledWith("hulk");
});

test("Run settings: the cap, and kind, mode and branch once there's a folder", () => {
  const onKind = vi.fn();
  const onMode = vi.fn();
  const onBranch = vi.fn();
  const p = show({
    run: { kind: "code", onKind, mode: "ask", onMode, branch: false, onBranch },
  });
  // What's set reads on the button itself.
  expect(screen.getByRole("button", { name: "Run settings" }).textContent).toContain(
    "Coding · Ask first · cap $1.00",
  );
  fireEvent.click(screen.getByRole("button", { name: "Run settings" }));
  const cap = screen.getByLabelText("Cost cap");
  expect(cap.getAttribute("placeholder")).toBe("1.00");
  fireEvent.change(cap, { target: { value: "0.5" } });
  fireEvent.blur(cap);
  expect(p.onCap).toHaveBeenCalledWith(500_000);
  fireEvent.click(screen.getByRole("button", { name: "Work run" }));
  expect(onKind).toHaveBeenCalledWith("work");
  fireEvent.change(screen.getByLabelText("What the coding run may do"), {
    target: { value: "auto_edit" },
  });
  expect(onMode).toHaveBeenCalledWith("auto_edit");
  fireEvent.click(screen.getByLabelText("New branch"));
  expect(onBranch).toHaveBeenCalledWith(true);
});

test("Run settings without a folder: only the cap", () => {
  show({ capMicroUsd: 2_500_000 });
  expect(screen.getByRole("button", { name: "Run settings" }).textContent).toContain("cap $2.50");
  fireEvent.click(screen.getByRole("button", { name: "Run settings" }));
  expect(screen.getByLabelText<HTMLInputElement>("Cost cap").value).toBe("2.50");
  expect(screen.queryByRole("button", { name: "Coding run" })).toBeNull();
});
