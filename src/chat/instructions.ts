// Custom instructions (M1 step 5, CH-05). They live in FUSE, not at a provider, so they apply
// the same way on every model. Projects (step 6) add a level between global and thread.
import { textTokens } from "@/files/documents";
import type { GlobalInstructions } from "@/storage/instructions";

/** Each box is capped so an instruction set can't quietly cost a lot on every message. */
export const MAX_INSTRUCTION_CHARS = 4000;

export type InstructionSource = "about_you" | "how_to_answer" | "thread";

export interface InstructionPart {
  source: InstructionSource;
  label: string;
  text: string;
}

const PARTS: { source: InstructionSource; label: string; tag: string }[] = [
  { source: "about_you", label: "About you", tag: "about_the_user" },
  { source: "how_to_answer", label: "How to answer", tag: "how_to_answer" },
  { source: "thread", label: "This chat", tag: "this_chat" },
];

/** The instructions in effect for a thread, broadest first; empty ones are left out. */
export function effectiveInstructions(
  global: GlobalInstructions,
  thread: string,
): InstructionPart[] {
  const text: Record<InstructionSource, string> = {
    about_you: global.aboutYou,
    how_to_answer: global.howToAnswer,
    thread,
  };
  return PARTS.flatMap(({ source, label }) => {
    const t = text[source].trim();
    return t ? [{ source, label, text: t }] : [];
  });
}

/**
 * The system prompt sent with every message. Global parts come first and the thread part last,
 * so the stable prefix is the same across threads (better prompt caching, RT-07).
 */
export function systemPrompt(parts: InstructionPart[]): string | undefined {
  if (parts.length === 0) return undefined;
  const blocks = parts.map((p) => {
    const tag = PARTS.find((x) => x.source === p.source)?.tag ?? p.source;
    return `<${tag}>\n${p.text}\n</${tag}>`;
  });
  return [
    "The user set these custom instructions. Follow them unless they ask otherwise in the conversation. Instructions for this chat take priority over the general ones.",
    ...blocks,
  ].join("\n\n");
}

/** Rough tokens added to every message by these instructions. */
export const instructionTokens = (parts: InstructionPart[]) =>
  textTokens(systemPrompt(parts) ?? "");
