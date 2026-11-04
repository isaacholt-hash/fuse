// @vitest-environment node
// M10 step 17: what a handoff starts with.
import { asksForAChange, offersCodeHandoff, chatBrief, codeBrief } from "./handoff";

test("a chat message that asks for a change", () => {
  expect(asksForAChange("Please fix the footer link")).toBe(true);
  expect(asksForAChange("Rename tide.ts to tides.ts")).toBe(true);
  expect(asksForAChange("What does this project do?")).toBe(false);
});

test("file edits offer Code independently of routing, without treating ordinary writing as files", () => {
  for (const text of [
    "Fix the typo in notes.txt",
    "Update docs/notes.txt",
    "Rename /home/me/notes to /home/me/archive",
    String.raw`Edit C:\work\notes.txt`,
    String.raw`Move .\notes to .\archive`,
    "Change résumé.txt",
  ])
    expect(offersCodeHandoff(text, "chat"), text).toBe(true);
  for (const text of [
    "Write a poem",
    "Edit this paragraph",
    "Explain notes.txt",
    "Read /home/me/notes.txt",
    "Write to hello@example.com",
    "Update https://example.com/notes.txt",
  ])
    expect(offersCodeHandoff(text, "writing"), text).toBe(false);
  expect(offersCodeHandoff("Fix the footer", "coding")).toBe(true);
  expect(offersCodeHandoff("Fix the footer", null)).toBe(true);
  expect(offersCodeHandoff("Explain the footer", "coding")).toBe(false);
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
