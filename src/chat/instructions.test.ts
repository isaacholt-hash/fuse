import { effectiveInstructions, instructionTokens, systemPrompt } from "./instructions";

test("empty boxes are left out; no instructions means no system prompt", () => {
  expect(effectiveInstructions({ aboutYou: " ", howToAnswer: "" }, "")).toEqual([]);
  expect(systemPrompt([])).toBeUndefined();
  expect(instructionTokens([])).toBe(0);
});

test("parts come broadest first, each in its own tag", () => {
  const parts = effectiveInstructions({ aboutYou: "", howToAnswer: "Be brief." }, "Use French.");
  expect(parts.map((p) => p.label)).toEqual(["How to answer", "This chat"]);
  expect(systemPrompt(parts)).toMatch(
    /take priority over the general ones\.\n\n<how_to_answer>\nBe brief\.\n<\/how_to_answer>\n\n<this_chat>\nUse French\.\n<\/this_chat>$/,
  );
  expect(instructionTokens(parts)).toBeGreaterThan(10);
});
