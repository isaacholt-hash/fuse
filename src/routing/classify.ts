/**
 * The local task classifier (RT-02): intent, complexity and needed capabilities from the question
 * itself, before anything is sent. Plain heuristics (length, code, attachments, keywords), so it is
 * free and instant. When they're unsure, the Cheap tier is asked as well (classifyFallback.ts).
 */
import type { Capability } from "@/catalog/catalog";
import type { Complexity, Intent, Task } from "./policy";

export interface ClassifyInput {
  text: string;
  /** Images attached to this question. */
  images?: number;
  /** Other files attached to this question (PDFs, text, code). */
  documents?: number;
  /** Estimated input tokens for the whole request: history, files and this question. */
  contextTokens?: number;
  /** The web search toggle is on. */
  webSearch?: boolean;
}

export interface Classification extends Task {
  /** Why, in a few words each, e.g. "code", "long question". Shown with the answer. */
  signals: string[];
  /**
   * The heuristics are unsure (RT-02): words of several kinds compete, or the difficulty sits on
   * the line between two tiers. Auto then asks the Cheap tier too.
   */
  unsure?: boolean;
}

/** Above this the request counts as a long document (about 30 pages of text). */
export const LONG_DOCUMENT_TOKENS = 20_000;
/** Questions this long are rarely casual. */
const LONG_QUESTION_CHARS = 600;
const MEDIUM_QUESTION_CHARS = 150;
const SHORT_QUESTION_CHARS = 80;
/** Shorter questions are never worth a second opinion. */
const UNSURE_MIN_CHARS = 60;

const CODE_FENCE = /```|^( {4}|\t)\S/m;
const CODE_WORDS =
  /\b(code|coding|function|class|method|bug|debug|stack ?trace|exception|compile|refactor|implement(ation)?|api|endpoint|sdk|repo(sitory)?|git|commit|pull request|deploy(ment|ed|ing)?|migration|database|schema|sql|regex|script|typescript|javascript|python|rust|golang|java|react|docker|kubernetes|terraform|powershell|bash|unit tests?|throttl\w*|rate limit\w*|mockup|frontend|backend|codebase|servers?|active directory|ldap|import (them|it|users?)|automat\w+|cron|webhook)\b|\b\w+\.(ts|tsx|js|py|rs|go|md|json|yaml|yml|sql|sh|ps1)\b/i;
const REASONING_WORDS =
  /\b(plan|planning|strategy|strateg\w+|architect\w*|design (a|the|an)|trade-?offs?|step[- ]by[- ]step|prove|proof|derive|why (does|do|is|would)|how would (we|you|i)|what would (be )?your|approach|reason through|think through|framework|roadmap|explain (this|why|how)|(can|could) (this|it|something like this) be (applied|used)|apply (this|it) to)\b/i;
const ANALYSIS_WORDS =
  /\b(analy[sz]e|analysis|assess\w*|evaluat\w+|compar\w+|break ?down|pros and cons|benchmark|versus|vs\.?|which is better|is .{2,40} (more|less) \w+ than|find the best|recommend\w*|budget|forecast|risk|realistic|options?|cost[- ]effective|teach me)\b/i;
const WRITING_WORDS =
  /\b(write|rewrite|draft|edit|proofread|summari[sz]e|email|letter|essay|blog|post|cover letter|resume|prompt|translate|tone|wording|schedule|outline|requirements?|spec(ification)?|document(ation)?)\b/i;
const CREATIVE_WORDS =
  /\b(brainstorm\w*|ideas?|story|poem|lyrics|fiction\w*|imagine|invent\w*|creative|fun|name (for|ideas)|slogan|tagline|character|influencer|animated|video)\b/i;
/** Words that mark a demanding task whatever its intent. */
const HARD_WORDS =
  /\b(architecture|technical (design|architecture)|implementation plan|phased|end[- ]to[- ]end|production|deploy\w*|migration|security|attack|defend|threat|detection|compliance|thorough\w*|in[- ]depth|detailed|comprehensive|rigorous\w*|verify|stable process|edge cases?|optimi[sz]e|scal(e|able|ing)|retire\w*|portfolio|trading|multi[- ]step|end state|correlat\w+|unless you need (input|anything)|without (asking|checking in)|go ahead and)\b/i;
/** Lists of requirements: numbered or bulleted lines. */
const LIST_ITEM = /^\s*(\d+[.)]|[-*•])\s+\S/gm;

const count = (re: RegExp, text: string) =>
  (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? [])
    .length;

export function classify(input: ClassifyInput): Classification {
  const text = input.text.trim();
  const images = input.images ?? 0;
  const documents = input.documents ?? 0;
  const contextTokens = input.contextTokens ?? Math.ceil(text.length / 4);
  const signals: string[] = [];

  const capabilities: Capability[] = [];
  if (images > 0) capabilities.push("vision");
  if (input.webSearch) capabilities.push("web_search");

  // Intent: the strongest evidence first.
  const code = CODE_FENCE.test(text);
  const codeWords = count(CODE_WORDS, text);
  let intent: Intent;
  if (images > 0) {
    intent = "vision";
    signals.push(images === 1 ? "an image" : `${String(images)} images`);
  } else if (code || codeWords >= 2 || (codeWords === 1 && text.length < SHORT_QUESTION_CHARS)) {
    intent = "coding";
    signals.push(code ? "code" : "coding words");
  } else if (contextTokens >= LONG_DOCUMENT_TOKENS || (documents > 0 && text.length < 200)) {
    intent = "long_document";
    signals.push(documents > 0 ? "attached document" : "long context");
  } else if (REASONING_WORDS.test(text)) {
    intent = "reasoning";
    signals.push("planning or reasoning");
  } else if (ANALYSIS_WORDS.test(text)) {
    intent = "analysis";
    signals.push("analysis");
  } else if (CREATIVE_WORDS.test(text)) {
    intent = "creative";
    signals.push("ideas");
  } else if (WRITING_WORDS.test(text)) {
    intent = "writing";
    signals.push("writing");
  } else if (codeWords === 1) {
    intent = "coding";
    signals.push("coding words");
  } else {
    intent = "chat";
  }

  // Complexity: length, structure and words that mark demanding work.
  const hard = count(HARD_WORDS, text);
  const listItems = count(LIST_ITEM, text);
  const thinking = count(REASONING_WORDS, text) + count(ANALYSIS_WORDS, text);
  let score = 0;
  if (text.length >= LONG_QUESTION_CHARS) {
    score += 2;
    signals.push("long question");
  } else if (text.length >= MEDIUM_QUESTION_CHARS) {
    score += 1;
  }
  if (hard > 0) {
    score += Math.min(hard, 2) * 2;
    signals.push("demanding task");
  }
  if (thinking >= 3) score += 1;
  if (listItems >= 3) {
    score += 1;
    signals.push("several requirements");
  }
  if (code && text.length >= 400) score += 1;
  if (contextTokens >= LONG_DOCUMENT_TOKENS) score += 1;
  const complexity: Complexity =
    score >= 3 ? "high" : score >= 1 || text.length >= SHORT_QUESTION_CHARS ? "medium" : "low";

  // Unsure: a real question (not a quick one, no image or long context deciding it) where
  // different kinds of words compete, or the difficulty is one point either side of "high".
  const kinds = [
    codeWords > 0,
    REASONING_WORDS.test(text),
    ANALYSIS_WORDS.test(text),
    CREATIVE_WORDS.test(text),
    WRITING_WORDS.test(text),
  ].filter(Boolean).length;
  const decided = images > 0 || code || contextTokens >= LONG_DOCUMENT_TOKENS;
  const unsure =
    !decided && text.length >= UNSURE_MIN_CHARS && (kinds >= 3 || score === 2 || score === 3);

  return {
    intent,
    complexity,
    capabilities,
    contextTokens,
    signals,
    ...(unsure ? { unsure } : {}),
  };
}

export const INTENT_LABELS: Record<Intent, string> = {
  chat: "chat",
  writing: "writing",
  coding: "coding",
  analysis: "analysis",
  long_document: "long document",
  reasoning: "reasoning",
  vision: "image",
  creative: "creative",
};
