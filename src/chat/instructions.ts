// Custom instructions (M1 step 5, CH-05). They live in FUSE, not at a provider, so they apply
// the same way on every model. Projects (step 6) add a level between global and thread.
import { textTokens } from "@/files/documents";
import type { GlobalInstructions } from "@/storage/instructions";

/** Each box is capped so an instruction set can't quietly cost a lot on every message. */
export const MAX_INSTRUCTION_CHARS = 4000;

export type InstructionSource = "about_you" | "how_to_answer" | "project" | "thread";

export interface InstructionPart {
  source: InstructionSource;
  label: string;
  text: string;
}

const PARTS: { source: InstructionSource; label: string; tag: string }[] = [
  { source: "about_you", label: "About you", tag: "about_the_user" },
  { source: "how_to_answer", label: "How to answer", tag: "how_to_answer" },
  { source: "project", label: "This project", tag: "project" },
  { source: "thread", label: "This chat", tag: "this_chat" },
];

/** The instructions in effect for a thread, broadest first; empty ones are left out. */
export function effectiveInstructions(
  global: GlobalInstructions,
  project: string,
  thread: string,
): InstructionPart[] {
  const text: Record<InstructionSource, string> = {
    about_you: global.aboutYou,
    how_to_answer: global.howToAnswer,
    project,
    thread,
  };
  return PARTS.flatMap(({ source, label }) => {
    const t = text[source].trim();
    return t ? [{ source, label, text: t }] : [];
  });
}

/** Everything besides the instructions that goes in the system prompt (PM-18 decides what). */
export interface PromptSections {
  /** Decisions and constraints in force: kept to unless the user changes them (PM-15). */
  pinned?: string[];
  /** Open tasks (PM-16). */
  tasks?: string[];
  memories?: string[];
  /** A summary of turns no longer sent in full (PM-06). */
  earlier?: string | null;
  /** App guides (e.g. artifacts): never change, so they head the cached prefix. */
  guides?: string[];
  /** Sections that change often, after everything else so the rest stays cached. */
  tail?: string[];
}

/**
 * The system prompt sent with every message, in the context assembler's order (PM-18): app
 * guides, instructions (global, then project, then chat, so the stable prefix is shared across
 * threads for prompt caching, RT-07), decisions and constraints, open tasks, memories, the
 * summary of earlier turns, then whatever changes most often.
 */
export function systemPrompt(
  parts: InstructionPart[],
  {
    pinned = [],
    tasks = [],
    memories = [],
    earlier = null,
    guides = [],
    tail = [],
  }: PromptSections = {},
): string | undefined {
  const sections: string[] = [...guides];
  if (parts.length > 0) {
    const blocks = parts.map((p) => {
      const tag = PARTS.find((x) => x.source === p.source)?.tag ?? p.source;
      return `<${tag}>\n${p.text}\n</${tag}>`;
    });
    sections.push(
      "The user set these custom instructions. Follow them unless they ask otherwise in the conversation. Narrower instructions take priority: this chat over the project, the project over the general ones.",
      ...blocks,
    );
  }
  if (pinned.length > 0) {
    sections.push(
      [
        "<decisions_and_constraints>",
        "Decisions the user made and constraints they set for this work. Keep to them unless the user changes one in this conversation; if a request would break one, say so.",
        ...pinned.map((m) => `- ${m}`),
        "</decisions_and_constraints>",
      ].join("\n"),
    );
  }
  if (tasks.length > 0) {
    sections.push(
      [
        "<open_tasks>",
        "Work still to do here. Use it for context; don't list it back unless asked.",
        ...tasks.map((m) => `- ${m}`),
        "</open_tasks>",
      ].join("\n"),
    );
  }
  if (memories.length > 0) {
    sections.push(
      [
        "<memories>",
        "Facts about the user that they asked to be remembered across chats. Use them when they help; don't list them back or mention this note. If the conversation contradicts one, the conversation wins.",
        ...memories.map((m) => `- ${m}`),
        "</memories>",
      ].join("\n"),
    );
  }
  if (earlier) {
    // Late: the summary changes as the thread grows, so everything above stays cacheable.
    sections.push(
      [
        "<earlier_conversation>",
        "A summary of the earlier part of this conversation, which is no longer shown in full. Treat it as what was said before the messages below.",
        earlier,
        "</earlier_conversation>",
      ].join("\n"),
    );
  }
  sections.push(...tail);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/** Rough tokens added to every message by these instructions. */
export const instructionTokens = (parts: InstructionPart[]) =>
  textTokens(systemPrompt(parts) ?? "");
