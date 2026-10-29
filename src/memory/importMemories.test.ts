// @vitest-environment node
import { guessKind, memoriesFromText, splitFacts } from "./importMemories";

test("one fact per line; headings, bullets and bold go; long prose splits into sentences", () => {
  const text = [
    "## Work context",
    "**Personal**",
    "- Lives in **Leeds**.",
    "2. Prefers metric units",
    "Interests:",
    "",
    `${"Runs a small consultancy that builds desktop apps. ".repeat(6)}It is growing.`,
  ].join("\n");
  const facts = splitFacts(text);
  expect(facts.slice(0, 2)).toEqual(["Lives in Leeds.", "Prefers metric units"]);
  expect(facts.length).toBe(9);
  expect(facts.at(-1)).toBe("It is growing.");
});

test("kinds are guessed from the words", () => {
  expect(guessKind("Has a daughter, Maya, aged 7")).toBe("person");
  expect(guessKind("Prefers short answers")).toBe("preference");
  expect(guessKind("Working on an app called FUSE")).toBe("fact");
  expect(guessKind("Lives in Leeds")).toBe("fact");
});

test("known facts and secrets are left out; the rest become suggestions to review", () => {
  const out = memoriesFromText(
    "Lives in Leeds.\nlives in leeds\nMy password is hunter2hunter2\nDrives an Atlas",
    ["Drives an Atlas"],
  );
  expect(out.proposals.map((p) => [p.text, p.op, p.sourceThreadId])).toEqual([
    ["Lives in Leeds.", "add", null],
  ]);
  expect(out.duplicates).toBe(2);
  expect(out.secrets).toBe(1);
});
