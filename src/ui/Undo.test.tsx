import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Undo, undoLabel } from "./Undo";

afterEach(cleanup);

test("says what went, and offers Undo and Dismiss", async () => {
  const calls: string[] = [];
  render(
    <Undo
      label="Deleted “Tile budget”"
      onUndo={() => calls.push("undo")}
      onDismiss={() => calls.push("dismiss")}
    />,
  );
  const user = userEvent.setup();
  expect(screen.getByRole("status")).toHaveTextContent("Deleted “Tile budget”");
  await user.click(screen.getByRole("button", { name: /^Undo/ }));
  await user.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(calls).toEqual(["undo", "dismiss"]);
});

test("labels", () => {
  expect(undoLabel({ kind: "thread", title: "Tile budget" })).toBe("Deleted “Tile budget”");
  expect(undoLabel({ kind: "thread", title: "" })).toBe("Deleted the chat");
  expect(undoLabel({ kind: "messages", count: 1 })).toBe("Deleted 1 answer");
  expect(undoLabel({ kind: "messages", count: 4 })).toBe("Deleted 4 messages");
});
