// @vitest-environment node
// M10 step 17: what a handoff starts with.
import { asksForAChange, chatBrief, codeBrief } from "./handoff";

test("a chat message that asks for a change", () => {
  expect(asksForAChange("Please fix the footer link")).toBe(true);
  expect(asksForAChange("Rename tide.ts to tides.ts")).toBe(true);
  expect(asksForAChange("What does this project do?")).toBe(false);
});

test("Continue in Code quotes the chat's last turns and leaves room for the task", () => {
  const brief = codeBrief("Footer", [
    { role: "user", content: "Old question" },
    { role: "assistant", content: "Old answer" },
    { role: "user", content: "The footer link is wrong" },
    { role: "assistant", content: "It points to /about;\nit should be /team." },
  ]);
  expect(brief.startsWith('Continuing from the chat "Footer":')).toBe(true);
  expect(brief).toContain("> It points to /about;\n> it should be /team.");
  expect(brief.endsWith("The task: ")).toBe(true);
});

test("Discuss in Chat says where the session got to and what it changed", () => {
  const brief = chatBrief("Fix the footer", "Changed the link.", ["Edited src/footer.ts"]);
  expect(brief).toContain("> Changed the link.");
  expect(brief).toContain("- Edited src/footer.ts");
  expect(brief.endsWith("My question: ")).toBe(true);
});
