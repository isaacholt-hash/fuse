// @vitest-environment node
import { classify } from "./classify";
import { parseClassifyReply } from "./classifyFallback";

test("the heuristics flag questions where kinds of words compete, not quick ones", () => {
  expect(classify({ text: "hi there" }).unsure).toBeUndefined();
  expect(classify({ text: "What's the capital of Peru?" }).unsure).toBeUndefined();
  expect(
    classify({
      text: "Can you write up a plan comparing two options for our team offsite, and draft the email?",
    }).unsure,
  ).toBe(true);
  // Code decides it: no second opinion needed.
  expect(
    classify({ text: "```ts\nconst a = 1\n```\nWhy does this plan to compare options fail?" })
      .unsure,
  ).toBeUndefined();
});

test("only a well-formed reply is used", () => {
  expect(parseClassifyReply('{"intent": "coding", "complexity": "high"}')).toEqual({
    intent: "coding",
    complexity: "high",
  });
  expect(
    parseClassifyReply('Sure! {"intent":"writing","complexity":"low"} hope that helps'),
  ).toEqual({
    intent: "writing",
    complexity: "low",
  });
  expect(parseClassifyReply('{"intent": "poetry", "complexity": "high"}')).toBeNull();
  expect(parseClassifyReply("no json")).toBeNull();
});
