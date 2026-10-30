// Test-only: FUSE's local worker (src-tauri/src/local_worker.rs) driven from Node, for the
// local benchmark. Same protocol as the app's src-tauri/src/local.rs, with no Tauri in between.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { localModels, type LocalProfile } from "../models";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const EXE = process.platform === "win32" ? "fuse.exe" : "fuse";

/** The built FUSE executable: FUSE_BIN, else the newer of the release and debug builds. */
export function findBinary(): string | null {
  if (process.env.FUSE_BIN) return existsSync(process.env.FUSE_BIN) ? process.env.FUSE_BIN : null;
  const built = ["release", "debug"]
    .map((profile) => join(ROOT, "src-tauri", "target", profile, EXE))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return built[0] ?? null;
}

/** The app's data folder (Tauri's app_data_dir for com.isaacholt.fuse). */
function appData(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "com.isaacholt.fuse");
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "com.isaacholt.fuse",
  );
}

/** Where FUSE on this computer keeps its model files. */
export const modelsDir = () => join(appData(), "models");

/** FUSE_LOCAL_MODEL, else the largest profile installed in the app. */
export function findModel(): { path: string; profile: LocalProfile | null } | null {
  const forced = process.env.FUSE_LOCAL_MODEL;
  if (forced) {
    const name = forced.split(/[\\/]/).at(-1) ?? "";
    return existsSync(forced)
      ? { path: forced, profile: localModels.profiles.find((p) => p.file === name) ?? null }
      : null;
  }
  for (const profile of localModels.profiles) {
    const path = join(appData(), "models", profile.file);
    if (existsSync(path)) return { path, profile };
  }
  return null;
}

type Event =
  | { ev: "loaded"; n_ctx: number }
  | { ev: "text"; id: string; text: string }
  | { ev: "done"; id: string; input_tokens: number; output_tokens: number; stop: string }
  | { ev: "error"; id: string | null; message: string };

export interface Generated {
  text: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export class NodeWorker {
  private child: ChildProcessWithoutNullStreams;
  private waiting: ((e: Event) => void)[] = [];
  private backlog: Event[] = [];
  private n = 0;

  constructor(binary: string) {
    // As the app starts it: an empty environment, so no key reaches it.
    this.child = spawn(binary, ["--local-worker"], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const deliver = (ev: Event) => {
      const next = this.waiting.shift();
      if (next) next(ev);
      else this.backlog.push(ev);
    };
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        deliver(JSON.parse(line) as Event);
      } catch {
        deliver({ ev: "error", id: null, message: `Not a worker reply: ${line.slice(0, 80)}` });
      }
    });
    // A worker that exits (or a binary from before M7, which has no worker mode) fails every
    // request still waiting, instead of hanging.
    const gone = (why: string) => {
      this.exited = why;
      while (this.waiting.length > 0) deliver({ ev: "error", id: null, message: why });
    };
    this.child.on("exit", (code, signal) => {
      gone(
        `The worker exited (${signal ?? `code ${String(code)}`}). If this FUSE build is older than M7, rebuild it.`,
      );
    });
    this.child.on("error", (e) => {
      gone(`Couldn't start the worker: ${e.message}`);
    });
  }

  private exited: string | null = null;

  private next(timeoutMs = 180_000): Promise<Event> {
    const ev = this.backlog.shift();
    if (ev) return Promise.resolve(ev);
    if (this.exited) return Promise.resolve({ ev: "error", id: null, message: this.exited });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ev: "error", id: null, message: "The worker didn't answer in time." });
      }, timeoutMs);
      this.waiting.push((e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
  }

  private send(req: object) {
    this.child.stdin.write(`${JSON.stringify(req)}\n`);
  }

  async load(path: string, threads: number): Promise<number> {
    const started = performance.now();
    this.send({ op: "load", path, n_ctx: 4096, threads });
    const ev = await this.next();
    if (ev.ev !== "loaded") throw new Error(ev.ev === "error" ? ev.message : "no load reply");
    return performance.now() - started;
  }

  async generate(system: string, user: string, maxTokens: number): Promise<Generated> {
    const id = `b${String(++this.n)}`;
    const started = performance.now();
    this.send({
      op: "generate",
      id,
      system,
      messages: [{ role: "user", content: user }],
      max_tokens: maxTokens,
    });
    let text = "";
    for (;;) {
      const ev = await this.next();
      if (ev.ev === "text") text += ev.text;
      else if (ev.ev === "done") {
        return {
          text,
          inputTokens: ev.input_tokens,
          outputTokens: ev.output_tokens,
          ms: performance.now() - started,
        };
      } else if (ev.ev === "error") throw new Error(ev.message);
    }
  }

  /** Peak resident memory in bytes, from /proc (Linux only); null elsewhere. */
  peakMemory(): number | null {
    try {
      const status = readFileSync(`/proc/${String(this.child.pid)}/status`, "utf8");
      const kb = /VmHWM:\s+(\d+) kB/.exec(status)?.[1];
      return kb ? Number(kb) * 1024 : null;
    } catch {
      return null;
    }
  }

  stop() {
    this.child.kill();
  }
}
