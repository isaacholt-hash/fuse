// @vitest-environment node
import { fuzzyScore } from "./fuzzy";

test("every typed letter in order; word starts and runs rank higher", () => {
  expect(fuzzyScore("nc", "Actions: New chat")).not.toBeNull();
  expect(fuzzyScore("xyz", "Actions: New chat")).toBeNull();
  expect(fuzzyScore("", "anything")).toBe(0);
  const startOfWord = fuzzyScore("set", "View: Settings") ?? 0;
  const middle = fuzzyScore("set", "Actions: Turn web search off") ?? 0;
  expect(startOfWord).toBeGreaterThan(middle);
});
