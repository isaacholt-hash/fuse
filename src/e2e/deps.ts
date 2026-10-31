// M8 step 14: what the click-through test build runs on (`vite build --mode e2e`, see
// e2e/README.md) instead of the real providers, keychain, updater and folder picker. main.tsx
// loads this only in that mode; CI checks a release bundle never contains E2E_MARK.
import { anthropicTurn, type Turn } from "@/agent/testing/turns";
import type { KeysApi } from "@/keys/api";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import type { FetchLike, ProviderAdapter } from "@/providers/types";
import type { ProviderId } from "@/catalog/catalog";
import { tauriRepo, type RepoApi } from "@/repo/api";
import type { UpdateApi } from "@/update/api";
import type { SqlDb, SqlValue } from "@/storage/sql";
import { openTauriDb } from "@/storage/tauriDb";

export const E2E_MARK = "fuse-e2e-scripted-build";

/** The folder "Add a folder" links; the test makes it first. */
const FOLDER = import.meta.env.VITE_E2E_FOLDER ?? "C:\\fuse-e2e";

/** Step 9's checklist commands, by check number (e2e/app.e2e.ts sends "E2E check <n>"). */
const CHECKS: Record<string, string> = {
  "2": "echo hi> inside.txt",
  "3": "echo x> %USERPROFILE%\\Documents\\escape.txt",
  "5": "echo hidden>NUL && echo shown",
};

export const HELLO = "Hello from the FUSE test script.";

/**
 * M9 step 6: "E2E python" runs this in the Work run's folder (the test writes data.csv). It
 * charts and totals the CSV, keeps the summary, and tries to write the folder, which it can't.
 */
const PYTHON_SCRIPT = [
  "import os, pandas as pd, matplotlib.pyplot as plt",
  'out = os.environ["FUSE_OUT"]',
  'df = pd.read_csv("data.csv")',
  'print("total", int(df.total.sum()))',
  'df.plot.bar(x="region", y="total")',
  'plt.savefig(os.path.join(out, "chart.png"))',
  'df.to_csv(os.path.join(out, "summary.csv"), index=False)',
  "try:",
  '    open("sneaky.txt", "w").write("x")',
  '    print("folder writable")',
  "except OSError as e:",
  '    print("folder read-only:", type(e).__name__)',
].join("\n");

interface Block {
  type: string;
  text?: string;
  content?: string | { type: string; text?: string }[];
}
interface Body {
  messages: { role: string; content: string | Block[] }[];
  tools?: { name?: string }[];
}

const blocks = (c: string | Block[]): Block[] =>
  typeof c === "string" ? [{ type: "text", text: c }] : c;
const resultText = (b: Block) =>
  typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x.text ?? "").join("\n");

/** The next turn for a request: a command for a check, then its result as the answer. */
export function scriptedTurn(body: Body): Turn {
  const last = body.messages.at(-1);
  const result = last ? blocks(last.content).find((b) => b.type === "tool_result") : undefined;
  if (result) return { text: `Command result:\n\n${resultText(result)}` };
  const lastAsked = body.messages
    .flatMap((m) => (m.role === "user" ? blocks(m.content) : []))
    .map((b) => b.text ?? "")
    .findLast((t) => t.includes("E2E "));
  if (lastAsked?.includes("E2E python")) {
    if (!body.tools?.some((t) => t.name === "run_python")) {
      return { text: "run_python wasn't offered." };
    }
    return {
      calls: [
        {
          name: "run_python",
          input: {
            script: PYTHON_SCRIPT,
            keep: [{ from: "summary.csv", to: "py-summary.csv" }],
            timeout_seconds: null,
          },
        },
      ],
    };
  }
  const asked = body.messages
    .flatMap((m) => (m.role === "user" ? blocks(m.content) : []))
    .map((b) => b.text ?? "")
    .reverse()
    .map((t) => /E2E check (\d)/.exec(t)?.[1])
    .find(Boolean);
  const command = asked ? CHECKS[asked] : undefined;
  if (body.tools?.length && command) {
    return { calls: [{ name: "run_command", input: { command, timeout_seconds: null } }] };
  }
  return { text: HELLO };
}

let turns = 0;
const scriptedFetch: FetchLike = (url, init) => {
  if (init.method === "GET") {
    return Promise.resolve(
      Response.json({
        data: [
          { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
          { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
        ],
        has_more: false,
      }),
    );
  }
  if (!url.endsWith("/v1/messages")) return Promise.resolve(new Response("{}", { status: 404 }));
  const body = JSON.parse(init.body ?? "{}") as Body;
  const turn = scriptedTurn(body);
  // For e2e/screenshots/console.log: which request got which turn, when.
  console.info(
    `e2e request ${String(turns + 1)}: ${String(body.messages.length)} messages, ${body.tools?.length ? "tools" : "no tools"} -> ${turn.calls?.length ? "tool call" : "text"}`,
  );
  return Promise.resolve(
    new Response(anthropicTurn(turn, ++turns), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
};

const keysApi: KeysApi = {
  status: (p) =>
    Promise.resolve(
      p === "anthropic" ? { saved: true, masked: "e2e…test" } : { saved: false, masked: null },
    ),
  save: () => Promise.reject(new Error("Keys can't be saved in the test build.")),
  test: () => Promise.resolve({ status: "ok", httpStatus: 200, latencyMs: 1, requestId: null }),
  remove: () => Promise.reject(new Error("Keys can't be removed in the test build.")),
};

/** A newer release is always "downloaded", so the update bar shows (M7 F1). */
const updates: UpdateApi = {
  version: () => Promise.resolve("0.0.0-e2e"),
  prepare: () => Promise.resolve("9.9.9"),
  installAndRestart: () => Promise.resolve(),
};

const repo: RepoApi = { ...tauriRepo, pick: () => tauriRepo.check(FOLDER) };

/** For e2e/screenshots/console.log: seconds since the page loaded. */
const at = () => `${(performance.now() / 1000).toFixed(1)}s`;

/** The adapter, saying when each turn's stream starts and ends. */
function logged(adapter: ProviderAdapter): ProviderAdapter {
  return {
    ...adapter,
    async *streamChat(messages, model, options, signal) {
      const n = ++streams;
      console.info(`e2e stream ${String(n)} asked at ${at()}`);
      let first = true;
      for await (const e of adapter.streamChat(messages, model, options, signal)) {
        if (first) console.info(`e2e stream ${String(n)} first event (${e.type}) at ${at()}`);
        first = false;
        yield e;
        if (e.type === "done") console.info(`e2e stream ${String(n)} done at ${at()}`);
      }
      console.info(`e2e stream ${String(n)} read to the end at ${at()}`);
    },
  };
}
let streams = 0;

/** The real database, reporting any call that takes over a second. */
async function loggedDb(): Promise<SqlDb> {
  const db = await openTauriDb();
  // Calls still waiting, listed every 5 s once they've waited that long.
  const waiting = new Map<number, { sql: string; since: number }>();
  let calls = 0;
  setInterval(() => {
    for (const w of waiting.values()) {
      const ms = performance.now() - w.since;
      if (ms > 5000) console.warn(`e2e db still waiting ${String(Math.round(ms))} ms: ${w.sql}`);
    }
  }, 5000);
  const slow = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    const id = ++calls;
    waiting.set(id, { sql: sql.replace(/\s+/g, " ").slice(0, 80), since: t });
    try {
      return await run();
    } catch (e) {
      console.error(
        `e2e db failed at ${at()}: ${String(e)} :: ${sql.replace(/\s+/g, " ").slice(0, 80)}`,
      );
      throw e;
    } finally {
      waiting.delete(id);
      const ms = performance.now() - t;
      if (ms > 1000) console.warn(`e2e slow db ${String(Math.round(ms))} ms: ${sql.slice(0, 80)}`);
    }
  };
  return {
    execute: async (sql, params) => {
      const r = await slow(sql, () => db.execute(sql, params));
      // When an answer is saved finished, and how many rows that touched.
      if (sql.includes("UPDATE messages SET content = ?, status = ?")) {
        console.info(
          `e2e db finished answer: ${String(params?.[1])}, ${String(r.rowsAffected)} row at ${at()}`,
        );
      }
      return r;
    },
    select: async <Row>(sql: string, params?: SqlValue[]) => {
      const rows = await slow(sql, () => db.select<Row>(sql, params));
      // What a chat's reload saw: each message's role and status.
      if (sql.includes("FROM messages") && sql.includes("parent_id, role, content, status")) {
        const seen = (rows as { role?: string; status?: string }[])
          .map((m) => `${m.role ?? "?"}:${m.status ?? "?"}`)
          .join(" ");
        console.info(`e2e db read messages [${seen}] at ${at()}`);
      }
      return rows;
    },
  };
}

export function e2eDeps() {
  // The test checks this before it clicks anything, so it never drives a real build.
  document.documentElement.dataset.build = E2E_MARK;
  const anthropic = logged(createAnthropicAdapter({ fetch: scriptedFetch }));
  return {
    keysApi,
    updates,
    openDb: loggedDb,
    repo,
    adapterFor: (p: ProviderId): ProviderAdapter => {
      if (p !== "anthropic") throw new Error(`${p} isn't scripted in the test build.`);
      return anthropic;
    },
  };
}
