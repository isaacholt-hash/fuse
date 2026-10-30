// CA-06: CLAUDE.md and AGENTS.md from the linked repository, as instructions. The root's files
// go with every request in the project; the agent adds the folders it works in, so nested files
// apply where they're meant to. Read through Rust, so ignore and secret rules hold (repo.rs).
import type { RepoApi } from "./api";

export const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
/** Per file. Longer files are cut, and the cut is marked. */
export const MAX_REPO_INSTRUCTION_CHARS = 16_000;

export interface RepoInstruction {
  /** Relative to the root, e.g. "CLAUDE.md" or "src/app/AGENTS.md". */
  path: string;
  text: string;
  cut: boolean;
}

/** "a/b/c" → ["", "a", "a/b", "a/b/c"]: the root first, so narrower files come later. */
function chain(dir: string): string[] {
  const parts = dir.split("/").filter((p) => p && p !== ".");
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

/**
 * The instruction files from the root down to each of `dirs` (default: the root only), broadest
 * first. A missing, ignored or unreadable file is skipped; a file identical to one already
 * loaded from the same folder (AGENTS.md linked to CLAUDE.md) is sent once.
 */
export async function loadRepoInstructions(
  repo: RepoApi,
  projectId: string,
  dirs: string[] = [""],
): Promise<RepoInstruction[]> {
  const folders = [...new Set(dirs.flatMap(chain))].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  const out: RepoInstruction[] = [];
  for (const folder of folders) {
    const seen = new Set<string>();
    for (const name of INSTRUCTION_FILES) {
      const path = folder ? `${folder}/${name}` : name;
      const file = await repo.read(projectId, path, 0).catch(() => null);
      if (!file) continue;
      const text = file.content.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const cut = file.truncated || text.length > MAX_REPO_INSTRUCTION_CHARS;
      out.push({
        path: file.path,
        text: cut
          ? `${text.slice(0, MAX_REPO_INSTRUCTION_CHARS)}\n[… cut: the file goes on past ${MAX_REPO_INSTRUCTION_CHARS.toLocaleString("en-GB")} characters]`
          : text,
        cut,
      });
    }
  }
  return out;
}
