/**
 * Threads are trees (CH-04): editing a question or regenerating an answer adds a sibling under the
 * same parent. The screen shows one path, root to the thread's active leaf. An answer re-run on a
 * stronger model (RT-04) sits beside the answer it re-ran, so the path shows both.
 */
import type { Message } from "./messages";

export interface BranchInfo {
  /** 1-based position among the siblings. */
  position: number;
  total: number;
  /** Sibling ids in order (oldest first). */
  siblings: string[];
}

const byCreated = (a: Message, b: Message) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** Children that start a branch: same parent, not a stronger re-run of another answer. */
function childrenOf(all: readonly Message[], parentId: string | null): Message[] {
  return all.filter((m) => m.parentId === parentId && m.escalatedFromId === null).sort(byCreated);
}

/** The stronger re-runs of an answer, newest last (a re-run can be re-run again). */
function rerunsOf(all: readonly Message[], answerId: string): Message[] {
  const out: Message[] = [];
  let current = answerId;
  for (;;) {
    const next = all
      .filter((m) => m.escalatedFromId === current)
      .sort(byCreated)
      .at(-1);
    if (!next) return out;
    out.push(next);
    current = next.id;
  }
}

/** The newest leaf under a message: follows re-runs, then the newest child, down to the end. */
export function leafUnder(all: readonly Message[], id: string): string {
  let current = id;
  for (;;) {
    const rerun = rerunsOf(all, current).at(-1);
    if (rerun) current = rerun.id;
    const next = childrenOf(all, current).at(-1);
    if (!next) return current;
    current = next.id;
  }
}

/**
 * The messages on screen, oldest first: root to `leafId` (or to the newest leaf when it's unset or
 * gone), with each answer's stronger re-runs placed right after it.
 */
export function buildPath(all: readonly Message[], leafId: string | null): Message[] {
  const byId = new Map(all.map((m) => [m.id, m]));
  const firstRoot = childrenOf(all, null).at(-1);
  const start =
    leafId !== null && byId.has(leafId) ? leafId : firstRoot ? leafUnder(all, firstRoot.id) : null;
  const chain: Message[] = [];
  let current = start === null ? undefined : byId.get(start);
  while (current) {
    chain.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  chain.reverse();
  // A re-run's original answer is its sibling, not its parent: put the originals back in front.
  const out: Message[] = [];
  for (const m of chain) {
    const originals: Message[] = [];
    let from = m.escalatedFromId === null ? undefined : byId.get(m.escalatedFromId);
    while (from) {
      originals.unshift(from);
      from = from.escalatedFromId === null ? undefined : byId.get(from.escalatedFromId);
    }
    out.push(...originals, m);
  }
  return out;
}

/** Sibling positions for every message on the path that has siblings. */
export function branchesOf(
  all: readonly Message[],
  path: readonly Message[],
): Map<string, BranchInfo> {
  const out = new Map<string, BranchInfo>();
  for (const m of path) {
    if (m.escalatedFromId !== null) continue;
    const siblings = childrenOf(all, m.parentId).filter((s) => s.role === m.role);
    if (siblings.length < 2) continue;
    out.set(m.id, {
      position: siblings.findIndex((s) => s.id === m.id) + 1,
      total: siblings.length,
      siblings: siblings.map((s) => s.id),
    });
  }
  return out;
}
