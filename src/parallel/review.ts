import { diffLines } from "@/artifacts/diff";
import type { ChildFileDiff } from "./types";

/** A commit as its first 7 characters, the way Git shows it; the full hash is on hover. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** "2 files, +14 −3 lines": what the reviewer is about to approve, before the diffs. */
export function changeSummary(files: ChildFileDiff[]): string {
  let add = 0;
  let del = 0;
  for (const f of files)
    for (const line of diffLines(f.before ?? "", f.after ?? "")) {
      // A new file has no old lines to remove, and a deleted one no new lines to add.
      if (line.kind === "add" && f.after !== null) add++;
      else if (line.kind === "del" && f.before !== null) del++;
    }
  const n = files.length;
  return `${String(n)} ${n === 1 ? "file" : "files"}, +${String(add)} −${String(del)} ${add + del === 1 ? "line" : "lines"}`;
}
