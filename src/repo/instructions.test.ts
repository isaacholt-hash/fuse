import type { RepoApi, RepoFileText } from "./api";
import { loadRepoInstructions, MAX_REPO_INSTRUCTION_CHARS } from "./instructions";

/** A fake repository: path → content. Reads of anything else fail like Rust's do. */
function fakeRepo(
  files: Record<string, string>,
  truncated: string[] = [],
): RepoApi & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("unused")),
    write: () => Promise.reject(new Error("read-only in this test")),
    remove: () => Promise.reject(new Error("read-only in this test")),
    move: () => Promise.reject(new Error("read-only in this test")),
    list: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
    read: (_projectId, path) => {
      reads.push(path);
      const content = files[path];
      if (content === undefined)
        return Promise.reject(new Error(`${path}: no such file or folder.`));
      const file: RepoFileText = {
        path,
        content,
        offset: 0,
        totalBytes: content.length,
        truncated: truncated.includes(path),
      };
      return Promise.resolve(file);
    },
  };
}

test("the root's CLAUDE.md and AGENTS.md, in that order", async () => {
  const repo = fakeRepo({
    "CLAUDE.md": "Use pnpm.\n",
    "AGENTS.md": "Run the tests.",
    "src/AGENTS.md": "x",
  });
  expect(await loadRepoInstructions(repo, "p")).toEqual([
    { path: "CLAUDE.md", text: "Use pnpm.", cut: false },
    { path: "AGENTS.md", text: "Run the tests.", cut: false },
  ]);
  expect(repo.reads).toEqual(["CLAUDE.md", "AGENTS.md"]);
});

test("nested files for the folders worked in, broadest first, each folder once", async () => {
  const repo = fakeRepo({
    "CLAUDE.md": "root",
    "src/CLAUDE.md": "src",
    "src/app/AGENTS.md": "app",
    "docs/AGENTS.md": "docs",
  });
  const got = await loadRepoInstructions(repo, "p", ["src/app", "docs", "src"]);
  expect(got.map((f) => f.path)).toEqual([
    "CLAUDE.md",
    "docs/AGENTS.md",
    "src/CLAUDE.md",
    "src/app/AGENTS.md",
  ]);
});

test("the same text twice in one folder (a symlink) is sent once; missing files are skipped", async () => {
  const repo = fakeRepo({ "CLAUDE.md": "Same.", "AGENTS.md": "Same." });
  expect((await loadRepoInstructions(repo, "p")).map((f) => f.path)).toEqual(["CLAUDE.md"]);
  expect(await loadRepoInstructions(fakeRepo({}), "p")).toEqual([]);
});

test("long files are cut, and say so", async () => {
  const long = "a".repeat(MAX_REPO_INSTRUCTION_CHARS + 50);
  const [file] = await loadRepoInstructions(fakeRepo({ "CLAUDE.md": long }), "p");
  expect(file?.cut).toBe(true);
  expect(file?.text).toMatch(/cut: the file goes on past 16,000 characters/);
  const [part] = await loadRepoInstructions(fakeRepo({ "CLAUDE.md": "short" }, ["CLAUDE.md"]), "p");
  expect(part?.cut).toBe(true);
});
