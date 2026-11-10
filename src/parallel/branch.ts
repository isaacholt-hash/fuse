/** "fuse/child/4b1ce1a0-b1d6-…" as "fuse/child/4b1ce1a0": a UUID shortens to its first block. */
export function shortBranch(branch: string): string {
  return branch.replace(
    /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "$1",
  );
}
