// @vitest-environment node
import { defaultPolicy } from "./defaultPolicy";
import { scoreGoldenSet } from "./evaluate";
import type { GoldenPrompt } from "./golden";

const p = (
  prompt: string,
  expectedTier: "balanced" | "best",
  needsContext = false,
): GoldenPrompt => ({
  prompt,
  expectedTier,
  intent: "chat",
  complexity: "low",
  needsContext,
  notes: "",
});

test("scores standalone and mid-conversation prompts apart, listing the misses", () => {
  const score = scoreGoldenSet(defaultPolicy, [
    p("What's a good name for a cat?", "balanced"),
    p(
      "Design the technical architecture and a phased implementation plan for our new billing system.",
      "best",
    ),
    p("What's the weather like on Mars?", "best"),
    p("ok do that", "best", true),
  ]);
  expect(score.standalone).toEqual({ correct: 2, total: 3 });
  expect(score.needsContext).toEqual({ correct: 0, total: 1 });
  expect(score.misses.map((m) => [m.position, m.expected, m.got, m.needsContext])).toEqual([
    [3, "best", "balanced", false],
    [4, "best", "balanced", true],
  ]);
  expect(score.misses[0]?.ruleId).toBe("default");
});
