import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WindowsSandboxSection } from "./WindowsSandbox";

afterEach(cleanup);

test("M8 step 9: the Windows sandbox switch, and Reset says what it put back", async () => {
  const onToggle = vi.fn();
  const onReset = vi.fn(() => Promise.resolve("Put back 2 folders."));
  render(<WindowsSandboxSection on={false} onToggle={onToggle} onReset={onReset} />);
  const box = screen.getByRole("checkbox", { name: "Run commands in the sandbox" });
  expect(box).not.toBeChecked();
  fireEvent.click(box);
  expect(onToggle).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Reset folder permissions" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Put back 2 folders.");
  expect(onReset).toHaveBeenCalledTimes(1);
});
