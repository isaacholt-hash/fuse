import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectRepoSection, type ProjectRepoProps } from "./ProjectRepo";

afterEach(cleanup);

function props(over: Partial<ProjectRepoProps> = {}): ProjectRepoProps {
  return {
    root: null,
    readSecrets: false,
    note: null,
    onLink: vi.fn(),
    onUnlink: vi.fn(),
    onReadSecrets: vi.fn(),
    ...over,
  };
}

test("no folder yet: a link button, and why the last try failed", () => {
  const p = props({ note: "Can't open that folder: permission denied" });
  render(<ProjectRepoSection {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Link a folder…" }));
  expect(p.onLink).toHaveBeenCalled();
  expect(screen.getByText(/permission denied/)).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("linked: the folder, change, unlink and the secrets switch", () => {
  const p = props({ root: "/home/me/lighthouse", note: "lighthouse: a git repository." });
  render(<ProjectRepoSection {...p} />);
  expect(screen.getByText("/home/me/lighthouse")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
  expect(p.onUnlink).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(p.onReadSecrets).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  expect(p.onLink).toHaveBeenCalled();
});
