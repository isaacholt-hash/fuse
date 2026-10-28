// @vitest-environment node
// Invented prompts: the real test set is Isaac's and never leaves his machine.
import { classify, LONG_DOCUMENT_TOKENS } from "./classify";

const read = (text: string, extra: Parameters<typeof classify>[0] = { text }) => {
  const c = classify({ ...extra, text });
  return `${c.intent}/${c.complexity}`;
};

test("short everyday questions are low-complexity chat", () => {
  expect(read("What's the capital of Peru?")).toBe("chat/low");
  expect(read("thanks, that worked")).toBe("chat/low");
});

test("intent comes from code, attachments and keywords", () => {
  expect(read("Why does this throw?\n```ts\nconst x: number = 'a';\n```")).toMatch(/^coding\//);
  expect(read("fix the bug in the login function")).toMatch(/^coding\//);
  expect(read("What's in this picture?", { text: "", images: 1 })).toMatch(/^vision\//);
  expect(read("Summarize it", { text: "", documents: 1 })).toMatch(/^long_document\//);
  expect(read("Compare the pros and cons of renting vs buying")).toMatch(/^analysis\//);
  expect(read("Brainstorm names for a bakery")).toMatch(/^creative\//);
  expect(read("Draft an email to my landlord about the heating")).toMatch(/^writing\//);
  expect(read("What would your plan be for learning Spanish in a year?")).toMatch(/^reasoning\//);
});

test("demanding, long or structured asks are high complexity", () => {
  expect(
    read(
      "Design the technical architecture and a phased implementation plan for moving our billing service to event sourcing.",
    ),
  ).toBe("reasoning/high");
  expect(
    read(
      "Continue with the next step of the payments refactor and deploy to staging unless you need input from me.",
    ),
  ).toBe("coding/high");
  expect(
    read(
      [
        "Write a migration script for the orders table that:",
        "1. adds a status column",
        "2. backfills it from the events table",
        "3. adds an index",
      ].join("\n"),
    ),
  ).toBe("coding/high");
});

test("a medium-length plain question is medium, not high", () => {
  expect(
    read("Which mid-range laptops have good battery life and a decent keyboard for writing?"),
  ).toMatch(/\/medium$/);
});

test("capabilities and context size are passed on", () => {
  const c = classify({ text: "look", images: 2, webSearch: true, contextTokens: 50_000 });
  expect(c.capabilities).toEqual(["vision", "web_search"]);
  expect(c.contextTokens).toBe(50_000);
  expect(c.signals).toContain("2 images");
  expect(classify({ text: "go on", contextTokens: LONG_DOCUMENT_TOKENS }).intent).toBe(
    "long_document",
  );
});
