/** The routing test set (RT-16): real prompts with the tier the user expects, from a JSON Lines file. */
import { findSecret, SECRET_LABELS } from "@/memory/secrets";
import type { Complexity, Intent, TierId } from "./policy";

export type ExpectedTier = Exclude<TierId, "cheap">;

export interface GoldenPrompt {
  prompt: string;
  expectedTier: ExpectedTier;
  intent: Intent;
  complexity: Complexity;
  /** Only makes sense mid-conversation; scored separately. */
  needsContext: boolean;
  notes: string;
}

export type GoldenParse = { ok: true; prompts: GoldenPrompt[] } | { ok: false; errors: string[] };

const TIERS: readonly ExpectedTier[] = ["balanced", "best"];
const INTENTS: readonly Intent[] = [
  "chat",
  "writing",
  "coding",
  "analysis",
  "long_document",
  "reasoning",
  "vision",
  "creative",
];
const COMPLEXITIES: readonly Complexity[] = ["low", "medium", "high"];
export const MAX_GOLDEN_PROMPTS = 500;
const MAX_PROMPT_CHARS = 20_000;
/** Notes written as "The missing context is …" mark a mid-conversation prompt. */
const MISSING_CONTEXT = /\bmissing context\b/i;

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

function parseLine(line: string): GoldenPrompt {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("expected a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is missing");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt is over ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters`);
  }
  const secret = findSecret(prompt);
  if (secret) throw new Error(`prompt looks like it contains ${SECRET_LABELS[secret]}`);
  if (o.expected_tier === "cheap") {
    throw new Error("expected_tier can't be cheap: the Cheap tier never answers");
  }
  const notes = typeof o.notes === "string" ? o.notes.trim() : "";
  if (o.needs_context !== undefined && typeof o.needs_context !== "boolean") {
    throw new Error("needs_context must be true or false");
  }
  return {
    prompt,
    expectedTier: oneOf(o.expected_tier, TIERS, "expected_tier"),
    intent: oneOf(o.intent, INTENTS, "intent"),
    complexity: oneOf(o.complexity, COMPLEXITIES, "complexity"),
    needsContext: o.needs_context ?? MISSING_CONTEXT.test(notes),
    notes,
  };
}

/**
 * One JSON object per line: prompt, expected_tier (balanced | best), intent, complexity, notes,
 * and optionally needs_context. Blank lines and a wrapping ``` fence are skipped. Any bad line
 * refuses the whole file, so a half-imported set never gets scored.
 */
export function parseGoldenSet(text: string): GoldenParse {
  const prompts: GoldenPrompt[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("```")) return;
    try {
      prompts.push(parseLine(trimmed));
    } catch (e) {
      errors.push(`Line ${String(i + 1)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  if (prompts.length === 0 && errors.length === 0) errors.push("The file has no prompts.");
  if (prompts.length > MAX_GOLDEN_PROMPTS) {
    errors.push(
      `The file has ${String(prompts.length)} prompts; the limit is ${String(MAX_GOLDEN_PROMPTS)}.`,
    );
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, prompts };
}

export interface GoldenSummary {
  total: number;
  balanced: number;
  best: number;
  needsContext: number;
}

export function summarize(
  prompts: readonly Pick<GoldenPrompt, "expectedTier" | "needsContext">[],
): GoldenSummary {
  return {
    total: prompts.length,
    balanced: prompts.filter((p) => p.expectedTier === "balanced").length,
    best: prompts.filter((p) => p.expectedTier === "best").length,
    needsContext: prompts.filter((p) => p.needsContext).length,
  };
}
