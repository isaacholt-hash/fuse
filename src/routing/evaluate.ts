/** Scores Auto routing against the routing test set (RT-16): does the classifier + policy pick the tier you expected? */
import { classify } from "./classify";
import type { ExpectedTier, GoldenPrompt } from "./golden";
import { chooseTier, type RoutingPolicy, type TierId } from "./policy";

export interface Miss {
  /** 1-based position in the imported file's prompts. */
  position: number;
  prompt: string;
  expected: ExpectedTier;
  got: TierId;
  ruleId: string;
  intent: string;
  complexity: string;
}

export interface Score {
  /** Prompts that stand on their own. */
  standalone: { correct: number; total: number };
  /** Prompts that only make sense mid-conversation: scored apart, since Auto sees one message. */
  needsContext: { correct: number; total: number };
  /** Standalone misses first, in file order. */
  misses: (Miss & { needsContext: boolean })[];
}

export function scoreGoldenSet(policy: RoutingPolicy, prompts: readonly GoldenPrompt[]): Score {
  const score: Score = {
    standalone: { correct: 0, total: 0 },
    needsContext: { correct: 0, total: 0 },
    misses: [],
  };
  prompts.forEach((p, i) => {
    const task = classify({ text: p.prompt });
    const choice = chooseTier(policy, task);
    const bucket = p.needsContext ? score.needsContext : score.standalone;
    bucket.total += 1;
    if (choice.tier === p.expectedTier) {
      bucket.correct += 1;
      return;
    }
    score.misses.push({
      position: i + 1,
      prompt: p.prompt,
      expected: p.expectedTier,
      got: choice.tier,
      ruleId: choice.rule.id,
      intent: task.intent,
      complexity: task.complexity,
      needsContext: p.needsContext,
    });
  });
  score.misses.sort((a, b) => Number(a.needsContext) - Number(b.needsContext));
  return score;
}

/** A policy change on the test set (RT-16): standalone accuracy before and after, and how many prompts move tier. */
export function compareOnGoldenSet(
  before: RoutingPolicy,
  after: RoutingPolicy,
  prompts: readonly GoldenPrompt[],
): {
  before: { correct: number; total: number };
  after: { correct: number; total: number };
  changed: number;
} {
  let changed = 0;
  for (const p of prompts) {
    const task = classify({ text: p.prompt });
    if (chooseTier(before, task).tier !== chooseTier(after, task).tier) changed += 1;
  }
  return {
    before: scoreGoldenSet(before, prompts).standalone,
    after: scoreGoldenSet(after, prompts).standalone,
    changed,
  };
}
