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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { docxText, xlsxSheets } from "@/documents/read";
import type { RepoApi } from "@/repo/api";
import type { ExecApi } from "@/repo/exec";
import type { GitApi } from "@/repo/git";

const ROOT = join(import.meta.dirname, "..", "..", "..");
export const FIXTURE = join(ROOT, "data", "coding", "fixture");
/** M8 step 13: the Work benchmark's folder of documents, CSVs and a messy folder. */
export const WORK_FIXTURE = join(ROOT, "data", "work", "fixture");

export type Check =
  | { kind: "file_contains"; path: string; text: string }
  | { kind: "file_unchanged"; path: string }
  | { kind: "command_passes"; command: string }
  | { kind: "branch_prefix"; prefix: string }
  | { kind: "last_commit_touches"; path: string }
  | { kind: "clean_tree" }
  // M8 step 13: Work checks. Paths are files in the folder; same_files compares with the fixture.
  | { kind: "docx_table"; path: string }
  | { kind: "docx_contains"; path: string; text: string }
  | { kind: "xlsx_formula"; path: string; text: string }
  | { kind: "xlsx_contains"; path: string; text: string }
  | { kind: "no_loose_files"; path: string }
  | { kind: "same_files"; path: string }
  // Checked by the benchmark itself, from the run's approvals.
  | { kind: "one_organise_plan" }
  // M9 step 7: checked by the benchmark itself, from the run's steps.
  | { kind: "used_tool"; tool: string };

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

/** M8 step 13: a fresh copy of the Work fixture, a plain folder (no git). */
export function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "fuse-work-"));
  cpSync(WORK_FIXTURE, dir, { recursive: true });
  return dir;
}

export interface WorkTask {
  id: string;
  task: string;
  /** M9 step 7: "python" when the task needs FUSE's Python. */
  requires?: "python";
  checks: Check[];
}

export function loadWorkTasks(): WorkTask[] {
  return (
    JSON.parse(readFileSync(join(ROOT, "data", "work", "tasks.json"), "utf8")) as {
      tasks: WorkTask[];
    }
  ).tasks;
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
    readBytes: (_p, path) => {
      const full = inside(dir, path);
      if (!existsSync(full)) return Promise.reject(new Error(`${path}: no such file.`));
      return Promise.resolve(new Uint8Array(readFileSync(full)));
    },
    writeBytes: (_p, path, bytes) => {
      const full = inside(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
      return Promise.resolve(rel(full));
    },
    removeBytes: (_p, path) => {
      rmSync(inside(dir, path));
      return Promise.resolve();
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

/**
 * M9 step 7: run_python for the recorded benchmark, with the system python3 (standard library
 * only) in `dir`, FUSE_OUT a fresh folder, and the files it wrote brought back. Not sandboxed:
 * that's tested in src-tauri/src/exec.rs and on the PCs, not here.
 */
export function nodePython(dir: string): NonNullable<ExecApi["python"]> {
  return (_p, script, { timeoutSecs }) =>
    new Promise((done) => {
      const started = Date.now();
      const work = mkdtempSync(join(tmpdir(), "fuse-bench-py-"));
      const out = join(work, "out");
      mkdirSync(out);
      const file = join(work, "script.py");
      writeFileSync(file, script);
      const child = spawn("python3", ["-I", file], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "", FUSE_OUT: out },
      });
      let output = "";
      child.stdout.on("data", (b: Buffer) => (output += b.toString()));
      child.stderr.on("data", (b: Buffer) => (output += b.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), (timeoutSecs ?? 120) * 1000);
      child.on("close", (code) => {
        clearTimeout(timer);
        const files = readdirSync(out, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => {
            const path = join(e.parentPath, e.name);
            return { path: relative(out, path).split(sep).join("/"), bytes: readFileSync(path) };
          });
        rmSync(work, { recursive: true, force: true });
        done({
          output,
          exitCode: code,
          timedOut: false,
          stopped: false,
          truncated: false,
          elapsedMs: Date.now() - started,
          files: files.map((f) => ({ path: f.path, bytes: new Uint8Array(f.bytes) })),
          skipped: [],
        });
      });
    });
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
      case "docx_table":
      case "docx_contains": {
        const bytes = readBytes(dir, c.path);
        const text = bytes ? docxText(bytes) : null;
        if (text === null) fails.push(`${c.path} wasn't made`);
        else if (c.kind === "docx_table" && !text.includes("| --- |"))
          fails.push(`${c.path} has no table`);
        else if (c.kind === "docx_contains" && !text.includes(c.text))
          fails.push(`${c.path} doesn't mention “${c.text}”`);
        break;
      }
      case "xlsx_formula":
      case "xlsx_contains": {
        const bytes = readBytes(dir, c.path);
        const cells = bytes ? xlsxSheets(bytes).flatMap((sh) => [...sh.cells.values()]) : null;
        if (cells === null) fails.push(`${c.path} wasn't made`);
        else if (c.kind === "xlsx_formula" && !cells.some((x) => x.formula?.includes(c.text)))
          fails.push(`${c.path} has no formula with “${c.text}”`);
        else if (c.kind === "xlsx_contains" && !cells.some((x) => x.value.includes(c.text)))
          fails.push(`${c.path} has no cell “${c.text}”`);
        break;
      }
      case "no_loose_files": {
        const loose = readdirSync(join(dir, c.path)).filter((n) =>
          statSync(join(dir, c.path, n)).isFile(),
        );
        if (loose.length) fails.push(`still loose in ${c.path}: ${loose.join(", ")}`);
        break;
      }
      case "same_files": {
        const names = (base: string) =>
          filesUnder(join(base, c.path))
            .map((f) => basename(f))
            .sort();
        const now = names(dir);
        const before = names(WORK_FIXTURE);
        if (now.join("\n") !== before.join("\n"))
          fails.push(`${c.path} now holds ${now.join(", ")} (was ${before.join(", ")})`);
        break;
      }
      case "used_tool":
      case "one_organise_plan":
        break;
    }
  }
  return fails;
}

function readBytes(dir: string, path: string): Uint8Array | null {
  const full = join(dir, path);
  return existsSync(full) ? new Uint8Array(readFileSync(full)) : null;
}

/** Every file under a folder, at any depth. */
function filesUnder(base: string): string[] {
  return readdirSync(base).flatMap((name) => {
    const full = join(base, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}
