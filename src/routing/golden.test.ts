import { parseGoldenSet, summarize } from "./golden";

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    prompt: "What's a frogman?",
    expected_tier: "balanced",
    intent: "chat",
    complexity: "low",
    notes: "A definition.",
    ...over,
  });

test("parses JSON Lines, skipping blank lines and a code fence", () => {
  const r = parseGoldenSet(
    ["```json", line(), "", line({ expected_tier: "best" }), "```", ""].join("\n"),
  );
  if (!r.ok) throw new Error(r.errors.join("; "));
  expect(r.prompts).toHaveLength(2);
  expect(r.prompts[0]).toEqual({
    prompt: "What's a frogman?",
    expectedTier: "balanced",
    intent: "chat",
    complexity: "low",
    needsContext: false,
    notes: "A definition.",
  });
  expect(summarize(r.prompts)).toEqual({ total: 2, balanced: 1, best: 1, needsContext: 0 });
});

test("needs_context comes from the field, or from notes naming the missing context", () => {
  const r = parseGoldenSet(
    [
      line({ notes: "The missing context is a 2026 VW Atlas." }),
      line({ needs_context: true }),
      line({ notes: "The missing context is X.", needs_context: false }),
    ].join("\n"),
  );
  if (!r.ok) throw new Error(r.errors.join("; "));
  expect(r.prompts.map((p) => p.needsContext)).toEqual([true, true, false]);
});

test.each([
  ["bad JSON", "{nope", /Line 1: not valid JSON/],
  ["a list", "[1]", /expected a JSON object/],
  ["no prompt", line({ prompt: "  " }), /prompt is missing/],
  ["Cheap", line({ expected_tier: "cheap" }), /never answers/],
  ["an unknown tier", line({ expected_tier: "great" }), /expected_tier must be/],
  ["an unknown intent", line({ intent: "poetry" }), /intent must be/],
  ["an unknown complexity", line({ complexity: "extreme" }), /complexity must be/],
  ["a key in the prompt", line({ prompt: "AWS key AKIA" + "ABCDEFGHIJKLMNOP" }), /API key/],
  ["a bad needs_context", line({ needs_context: "yes" }), /needs_context/],
])("refuses %s", (_name, text, error) => {
  const r = parseGoldenSet(text);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join("\n")).toMatch(error);
});

test("one bad line refuses the whole file, and every bad line is listed", () => {
  const r = parseGoldenSet([line(), "oops", line({ intent: "x" })].join("\n"));
  expect(r).toEqual({
    ok: false,
    errors: [
      "Line 2: not valid JSON",
      "Line 3: intent must be one of chat, writing, coding, analysis, long_document, reasoning, vision, creative",
    ],
  });
});

test("an empty file is refused", () => {
  expect(parseGoldenSet("\n\n")).toEqual({ ok: false, errors: ["The file has no prompts."] });
});
