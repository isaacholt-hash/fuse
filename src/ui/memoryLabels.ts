import type { MemoryKindView } from "./types";

/** Memory kinds as grouped in "What do you know about me" (PM-07). */
export const KIND_LABELS: Record<MemoryKindView, string> = {
  fact: "About you",
  preference: "Preferences",
  person: "People",
  constraint: "Constraints",
  decision: "Decisions",
  task: "Tasks",
  source: "Sources",
};

/** Kinds you can add from Settings → Memory; decisions and tasks live in their project. */
export const ADDABLE_KINDS: readonly MemoryKindView[] = [
  "fact",
  "preference",
  "person",
  "constraint",
  "source",
];
