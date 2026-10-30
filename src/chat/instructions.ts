// Custom instructions (M1 step 5, CH-05). They live in FUSE, not at a provider, so they apply
// the same way on every model. Projects (step 6) add a level between global and thread.
import { textTokens } from "@/files/documents";
import type { RepoInstruction } from "@/repo/instructions";
import type { GlobalInstructions } from "@/storage/instructions";

/** Each box is capped so an instruction set can't quietly cost a lot on every message. */
export const MAX_INSTRUCTION_CHARS = 4000;

/** `repo`: a CLAUDE.md or AGENTS.md from the project's linked repository (CA-06). */
export type InstructionSource = "about_you" | "how_to_answer" | "project" | "repo" | "thread";

export interface InstructionPart {
  source: InstructionSource;
  label: string;
  text: string;
  /** For `repo`: the file, relative to the repository root. */
  path?: string;
}

const PARTS: { source: InstructionSource; label: string; tag: string }[] = [
  { source: "about_you", label: "About you", tag: "about_the_user" },
  { source: "how_to_answer", label: "How to answer", tag: "how_to_answer" },
  { source: "project", label: "This project", tag: "project" },
  { source: "repo", label: "Repository", tag: "repository_file" },
  { source: "thread", label: "This chat", tag: "this_chat" },
];

/**
 * The instructions in effect for a thread, broadest first; empty ones are left out. Repository
 * files (CA-06) sit between the project's and the chat's, broadest file first.
 */
export function effectiveInstructions(
  global: GlobalInstructions,
  project: string,
  thread: string,
  repo: RepoInstruction[] = [],
): InstructionPart[] {
  const text: Record<Exclude<InstructionSource, "repo">, string> = {
    about_you: global.aboutYou,
    how_to_answer: global.howToAnswer,
    project,
    thread,
  };
  return PARTS.flatMap(({ source, label }): InstructionPart[] => {
    if (source === "repo") {
      return repo.map((f) => ({ source, label: f.path, text: f.text, path: f.path }));
    }
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
      const attr = p.path ? ` path="${p.path.replace(/"/g, "'")}"` : "";
      return `<${tag}${attr}>\n${p.text}\n</${tag}>`;
    });
    sections.push(
      parts.some((p) => p.source === "repo")
        ? "The user set these custom instructions, and the project's repository has instruction files (repository_file). Follow them unless they ask otherwise in the conversation. Narrower instructions take priority: this chat over the repository's files, a deeper folder's file over the root's, the repository's files over the project's, and the project's over the general ones."
        : "The user set these custom instructions. Follow them unless they ask otherwise in the conversation. Narrower instructions take priority: this chat over the project, the project over the general ones.",
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
