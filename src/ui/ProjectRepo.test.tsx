import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectRepoSection, type ProjectRepoProps } from "./ProjectRepo";

afterEach(cleanup);

function props(over: Partial<ProjectRepoProps> = {}): ProjectRepoProps {
  return {
    folders: [],
    note: null,
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onReadSecrets: vi.fn(),
    ...over,
  };
}

test("no folder yet: a link button, and why the last try failed", () => {
  const p = props({ note: "Can't open that folder: permission denied" });
  render(<ProjectRepoSection {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Link a folder…" }));
  expect(p.onAdd).toHaveBeenCalled();
  expect(screen.getByText(/permission denied/)).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("several folders (WF-02): each with remove and its own secrets switch, and add more", () => {
  const p = props({
    folders: [
      { id: "a", path: "/home/me/lighthouse", readSecrets: false },
      { id: "b", path: "/home/me/notes", readSecrets: true },
    ],
    note: "notes: not a git repository, so git steps won't work there.",
  });
  render(<ProjectRepoSection {...p} />);
  expect(screen.getByText("/home/me/lighthouse")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove /home/me/notes" }));
  expect(p.onRemove).toHaveBeenCalledWith("b");
  const [first] = screen.getAllByRole("checkbox");
  if (first) fireEvent.click(first);
  expect(p.onReadSecrets).toHaveBeenCalledWith("a", true);
  fireEvent.click(screen.getByRole("button", { name: "Add a folder…" }));
  expect(p.onAdd).toHaveBeenCalled();
});

test("M10 step 11: run limits save whole minutes and dollars; empty means FUSE's default", () => {
  const onLimits = vi.fn();
  const p = props({
    folders: [{ id: "a", path: "/home/me/lighthouse", readSecrets: false }],
    limits: { capMicroUsd: null, wallMinutes: 90, idleMinutes: null },
    onLimits,
  });
  const { rerender } = render(<ProjectRepoSection {...p} />);
  const idle = screen.getByLabelText("Stop a run when nothing happens for (minutes)");
  expect(idle.getAttribute("placeholder")).toBe("15");
  fireEvent.change(idle, { target: { value: "30" } });
  fireEvent.blur(idle);
  expect(onLimits).toHaveBeenCalledWith({ idleMinutes: 30 });
  const cap = screen.getByLabelText("Cost cap per run (dollars)");
  fireEvent.change(cap, { target: { value: "2.5" } });
  fireEvent.blur(cap);
  expect(onLimits).toHaveBeenCalledWith({ capMicroUsd: 2_500_000 });
  const wall = screen.getByLabelText<HTMLInputElement>("Stop a run after (minutes)");
  expect(wall.value).toBe("90");
  fireEvent.change(wall, { target: { value: "" } });
  fireEvent.blur(wall);
  expect(onLimits).toHaveBeenCalledWith({ wallMinutes: null });
  // Once saved, leaving a field as it is saves nothing.
  rerender(
    <ProjectRepoSection
      {...p}
      limits={{ capMicroUsd: 2_500_000, wallMinutes: null, idleMinutes: 30 }}
    />,
  );
  fireEvent.blur(screen.getByLabelText("Stop a run when nothing happens for (minutes)"));
  expect(onLimits).toHaveBeenCalledTimes(3);
});
