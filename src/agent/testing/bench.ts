// Test-only: the coding benchmark's harness (M6 step 13). A fresh copy of data/coding/fixture in
// a new git repository, Node versions of the repository, command and git interfaces over it (the
// app's are in Rust), and the checks that decide whether a task passed.
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { RepoApi } from "@/repo/api";
import type { ExecApi } from "@/repo/exec";
import type { GitApi } from "@/repo/git";

const ROOT = join(import.meta.dirname, "..", "..", "..");
export const FIXTURE = join(ROOT, "data", "coding", "fixture");

export type Check =
  | { kind: "file_contains"; path: string; text: string }
  | { kind: "file_unchanged"; path: string }
  | { kind: "command_passes"; command: string }
  | { kind: "branch_prefix"; prefix: string }
  | { kind: "last_commit_touches"; path: string }
  | { kind: "clean_tree" };

export interface BenchTask {
  id: string;
  task: string;
  mode: "auto_edit";
  newBranch: boolean;
  checks: Check[];
}

export function loadTasks(): BenchTask[] {
  return (
    JSON.parse(readFileSync(join(ROOT, "data", "coding", "tasks.json"), "utf8")) as {
      tasks: BenchTask[];
    }
  ).tasks;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "FUSE Benchmark",
  GIT_AUTHOR_EMAIL: "bench@example.invalid",
  GIT_COMMITTER_NAME: "FUSE Benchmark",
  GIT_COMMITTER_EMAIL: "bench@example.invalid",
};

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, { cwd: dir, env: { ...process.env, ...IDENTITY }, encoding: "utf8" });

/** A fresh copy of the fixture, committed on main. Remove it with `rmSync(dir, {recursive})`. */
export function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fuse-bench-"));
  cpSync(FIXTURE, dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "Start"]);
  return dir;
}

export const dropRepo = (dir: string) => {
  rmSync(dir, { recursive: true, force: true });
};

function inside(dir: string, rel: string): string {
  if (!rel || rel === ".") return dir;
  if (rel.split(/[\\/]/).includes("..") || resolve(rel) === rel)
    throw new Error(`${rel}: use a path inside the repository.`);
  const full = resolve(dir, rel);
  if (full !== dir && !full.startsWith(dir + sep))
    throw new Error(`${rel} is outside the repository.`);
  if (relative(dir, full).split(sep)[0] === ".git")
    throw new Error(`${rel}: the .git folder can't be used.`);
  return full;
}

/** The repository interface over a folder, with the same path rules as Rust (less .gitignore). */
export function nodeRepo(dir: string): RepoApi {
  const walk = (base: string): string[] =>
    readdirSync(base).flatMap((name) => {
      if (name === ".git") return [];
      const full = join(base, name);
      return statSync(full).isDirectory() ? [full + sep, ...walk(full)] : [full];
    });
  const rel = (full: string) => relative(dir, full).split(sep).join("/");
  return {
    pick: () => Promise.resolve(null),
    check: () => Promise.resolve({ root: dir, name: "fixture", isGit: true }),
    list: (_p, path, recursive) => {
      const base = inside(dir, path);
      const all = recursive
        ? walk(base)
        : readdirSync(base)
            .filter((n) => n !== ".git")
            .map((n) => join(base, n));
      return Promise.resolve(
        all.map((full) => {
          const isDir = full.endsWith(sep) || statSync(full).isDirectory();
          const clean = full.endsWith(sep) ? full.slice(0, -1) : full;
          return {
            path: rel(clean),
            dir: isDir,
            size: isDir ? 0 : statSync(clean).size,
            secret: false,
          };
        }),
      );
    },
    read: (_p, path, offset) => {
      const full = inside(dir, path);
      if (!existsSync(full) || statSync(full).isDirectory())
        return Promise.reject(new Error(`${path}: no such file or folder.`));
      const text = readFileSync(full, "utf8");
      const content = text.slice(offset);
      return Promise.resolve({
        path: rel(full),
        content,
        offset,
        totalBytes: text.length,
        truncated: false,
      });
    },
    search: (_p, path, query, ignoreCase) => {
      const needle = ignoreCase ? query.toLowerCase() : query;
      const hits = walk(inside(dir, path))
        .filter((f) => !f.endsWith(sep))
        .flatMap((f) =>
          readFileSync(f, "utf8")
            .split("\n")
            .flatMap((line, i) =>
              (ignoreCase ? line.toLowerCase() : line).includes(needle)
                ? [{ path: rel(f), line: i + 1, text: line.trim() }]
                : [],
            ),
        );
      return Promise.resolve(hits.slice(0, 200));
    },
    write: (_p, path, content) => {
      const full = inside(dir, path);
      const before = existsSync(full) ? readFileSync(full, "utf8") : null;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return Promise.resolve({ path: rel(full), before });
    },
    remove: (_p, path) => {
      const full = inside(dir, path);
      if (!existsSync(full)) return Promise.reject(new Error(`${path}: no such file.`));
      const before = readFileSync(full, "utf8");
      rmSync(full);
      return Promise.resolve({ path: rel(full), before });
    },
    move: (_p, from, to) => {
      const a = inside(dir, from);
      const b = inside(dir, to);
      if (existsSync(b)) return Promise.reject(new Error(`${to} already exists.`));
      mkdirSync(dirname(b), { recursive: true });
      renameSync(a, b);
      return Promise.resolve({ path: rel(b), before: null });
    },
  };
}

/** Commands in the folder, as Rust runs them: a shell, no input, a time limit. */
export function nodeExec(dir: string): ExecApi {
  return {
    run: (_p, command, { timeoutSecs, onOutput }) =>
      new Promise((done) => {
        const started = Date.now();
        const child = spawn("bash", ["-c", command], {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...IDENTITY },
        });
        let output = "";
        let timedOut = false;
        const add = (b: Buffer) => {
          output += b.toString();
          onOutput?.(output);
        };
        child.stdout.on("data", add);
        child.stderr.on("data", add);
        const timer = setTimeout(
          () => {
            timedOut = true;
            child.kill("SIGKILL");
          },
          (timeoutSecs ?? 120) * 1000,
        );
        child.on("close", (code) => {
          clearTimeout(timer);
          done({
            output,
            exitCode: timedOut ? null : code,
            timedOut,
            stopped: false,
            truncated: false,
            elapsedMs: Date.now() - started,
          });
        });
      }),
  };
}

/** git with an argument list; gh isn't there in the benchmark (no network). */
export function nodeGit(dir: string): GitApi {
  return {
    run: (_p, program, args) => {
      if (program !== "git")
        return Promise.resolve({ output: "gh isn't available in the benchmark.", exitCode: 1 });
      try {
        return Promise.resolve({ output: git(dir, args), exitCode: 0 });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        return Promise.resolve({
          output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
          exitCode: err.status ?? 1,
        });
      }
    },
  };
}

/** Which checks failed, in plain words; empty means the task passed. */
export function failedChecks(dir: string, checks: Check[]): string[] {
  const fails: string[] = [];
  const read = (p: string) =>
    existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null;
  for (const c of checks) {
    switch (c.kind) {
      case "file_contains":
        if (!read(c.path)?.includes(c.text)) fails.push(`${c.path} doesn't contain “${c.text}”`);
        break;
      case "file_unchanged":
        if (read(c.path) !== readFileSync(join(FIXTURE, c.path), "utf8"))
          fails.push(`${c.path} was changed`);
        break;
      case "command_passes":
        try {
          execFileSync("bash", ["-c", c.command], { cwd: dir, stdio: "pipe" });
        } catch {
          fails.push(`\`${c.command}\` fails`);
        }
        break;
      case "branch_prefix": {
        const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
        if (!branch.startsWith(c.prefix)) fails.push(`on branch ${branch}, not ${c.prefix}…`);
        break;
      }
      case "last_commit_touches": {
        const files = git(dir, ["show", "--name-only", "--format=", "HEAD"])
          .split("\n")
          .filter(Boolean);
        if (!files.includes(c.path)) fails.push(`the last commit doesn't touch ${c.path}`);
        break;
      }
      case "clean_tree":
        if (git(dir, ["status", "--porcelain"]).trim()) fails.push("uncommitted changes are left");
        break;
    }
  }
  return fails;
}
