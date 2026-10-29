/**
 * Importing memories from ChatGPT or Claude (PM-08): pasted text split into facts, one per line
 * (headings dropped, long prose split into sentences), already-known ones and secrets left out.
 * The facts become suggestions for the usual review, so nothing is saved without a yes.
 */
import type { MemoryKind, NewProposal } from "@/storage/memories";
import { findSecret } from "./secrets";

const MAX_LINE = 300;

/** Lowercase letters and digits only, for spotting the same fact twice. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function guessKind(text: string): MemoryKind {
  if (
    /\b(wife|husband|partner|son|daughter|kids?|children|mother|mum|mom|father|dad|brother|sister|friend|colleague|boss|manager)\b/i.test(
      text,
    )
  ) {
    return "person";
  }
  if (
    /\b(prefers?|likes?|loves?|hates?|dislikes?|enjoys?|wants?|always|never|favou?rite|style)\b/i.test(
      text,
    )
  ) {
    return "preference";
  }
  return "fact";
}

/** The facts in pasted text, in order, without headings, bullets or numbering. */
export function splitFacts(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = raw
      .trim()
      .replace(/^([-*•·▪]|\d+[.)])\s+/, "")
      .trim();
    if (!line) continue;
    // Headings: markdown ones, bold-only lines, and short lines ending in a colon.
    if (
      /^#{1,6}\s/.test(line) ||
      /^\*\*[^*]+\*\*:?$/.test(line) ||
      (line.endsWith(":") && line.length < 60)
    ) {
      continue;
    }
    line = line.replace(/\*\*([^*]+)\*\*/g, "$1");
    if (line.length <= MAX_LINE) {
      out.push(line);
      continue;
    }
    for (const sentence of line.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [line]) {
      if (sentence.trim()) out.push(sentence.trim());
    }
  }
  return out;
}

export interface MemoryImport {
  proposals: NewProposal[];
  /** Facts already saved or already waiting for review. */
  duplicates: number;
  /** Lines that looked like a key, password or card number: never stored (PM-05). */
  secrets: number;
}

export function memoriesFromText(text: string, known: readonly string[]): MemoryImport {
  const seen = new Set(known.map(norm));
  const proposals: NewProposal[] = [];
  let duplicates = 0;
  let secrets = 0;
  for (const fact of splitFacts(text)) {
    if (findSecret(fact)) {
      secrets += 1;
      continue;
    }
    const key = norm(fact);
    if (!key || seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    proposals.push({
      op: "add",
      memoryId: null,
      text: fact,
      kind: guessKind(fact),
      projectId: null,
      confidence: 100,
      sourceThreadId: null,
    });
  }
  return { proposals, duplicates, secrets };
}
