// M10 step 16: the new-session bar.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NewSessionBar } from "./NewSession";

afterEach(cleanup);

function show(over: Partial<Parameters<typeof NewSessionBar>[0]> = {}) {
  const props = {
    projects: [{ id: "p1", name: "Lighthouse" }],
    projectId: null,
    onProject: vi.fn(),
    where: "local" as const,
    onWhere: vi.fn(),
    whereReasons: { local: null, hulk: "Pair with HULK in Settings first" },
    capMicroUsd: null,
    defaultCapMicroUsd: 1_000_000,
    onCap: vi.fn(),
    noFolder: null,
    ...over,
  };
  render(<NewSessionBar {...props} />);
  return props;
}

test("project, where (greyed with why) and cap, in that order", () => {
  const p = show();
  const bar = screen.getByRole("group", { name: "New session" });
  const order = [
    screen.getByLabelText("Project or repository"),
    screen.getByRole("group", { name: "Where it runs" }),
    screen.getByLabelText("Cost cap"),
  ];
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1] as Node;
    const b = order[i] as Node;
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(bar).toBeInTheDocument();
  const hulk = within(screen.getByRole("group", { name: "Where it runs" })).getByRole("button", {
    name: "HULK",
  });
  expect(hulk).toBeDisabled();
  expect(screen.getByText("Pair with HULK in Settings first")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Project or repository"), { target: { value: "p1" } });
  expect(p.onProject).toHaveBeenCalledWith("p1");
  const cap = screen.getByLabelText("Cost cap");
  expect(cap.getAttribute("placeholder")).toBe("1.00");
  fireEvent.change(cap, { target: { value: "0.5" } });
  fireEvent.blur(cap);
  expect(p.onCap).toHaveBeenCalledWith(500_000);
});

test("no folder yet: it says what to do", () => {
  show({ noFolder: "Pick a project with a folder, or add a folder below." });
  expect(
    screen.getByText("Pick a project with a folder, or add a folder below."),
  ).toBeInTheDocument();
});
