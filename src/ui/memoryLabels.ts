import type { MemoryCategoryView } from "./types";

/** Memory categories as grouped in "What do you know about me" (PM-07). */
export const CATEGORY_LABELS: Record<MemoryCategoryView, string> = {
  fact: "About you",
  preference: "Preferences",
  person: "People",
  project: "Projects",
};
