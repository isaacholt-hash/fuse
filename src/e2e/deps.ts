import { isDesktop } from "@/platform/core";
import { zipSync, strToU8 } from "fflate";
import { recordedSkillAdapter } from "@/skills/testing/scripted";
import { recordedParallelAdapter } from "@/parallel/testing/scripted";
import { tauriExec } from "@/repo/exec";
import { tauriPythonApi } from "@/python/runtime";
import { importSkill } from "@/skills/storage";
import { readSkillPackage } from "@/skills/package";
import { scriptedResearchAdapter, scriptedResearchWeb } from "@/research/testing/scripted";
import { scriptedConnectorsApi } from "@/connectors/testing/scripted";
import {
  createProject,
  getProject,
  setProjectRepo,
  setProjectRunMode,
  setProjectRunLimits,
} from "@/storage/projects";
import { createThread } from "@/storage/threads";
import { recordedReviewAdapter } from "@/review/testing/scripted";
import { tauriWebApi } from "@/web/api";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import type { DictationApi } from "@/dictation/client";
import { encodeRecording } from "@/dictation/wav";
import { logRequest } from "@/storage/requestLog";
import { EMPTY_USAGE } from "@/storage/usage";
import { DEFAULT_TENANT } from "@/storage/defaults";
// M8 step 14: what the click-through test build runs on (`vite build --mode e2e`, see
// e2e/README.md) instead of the real providers, keychain, updater and folder picker. main.tsx
// loads this only in that mode; CI checks a release bundle never contains E2E_MARK.
import { anthropicTurn, type Turn } from "@/agent/testing/turns";
import type { HulkApi } from "@/handover/api";
import type { KeysApi } from "@/keys/api";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import type { FetchLike, ProviderAdapter } from "@/providers/types";
import type { ProviderId } from "@/catalog/catalog";
import { tauriRepo, type RepoApi } from "@/repo/api";
import type { UpdateApi } from "@/update/api";
import type { SqlDb, SqlValue } from "@/storage/sql";
import { openTauriDb } from "@/storage/tauriDb";

export const E2E_MARK = "fuse-e2e-scripted-build";

// The host may already be paired. Scripted tests must never use or change that live link.
const noLiveHulk = () =>
  Promise.reject(new Error("Live HULK access is disabled in the scripted test build."));
const hulk: HulkApi = {
  status: () =>
    Promise.resolve({ address: null, paired: false, mine: null, server: null, mismatch: null }),
  pair: noLiveHulk,
  unpair: noLiveHulk,
  invoke: noLiveHulk,
  putFile: noLiveHulk,
};

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
  system?: string | { text?: string }[];
  messages: { role: string; content: string | Block[] }[];
  tools?: { name?: string }[];
}

const blocks = (c: string | Block[]): Block[] =>
  typeof c === "string" ? [{ type: "text", text: c }] : c;
const resultText = (b: Block) =>
  typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x.text ?? "").join("\n");

/** The next turn for a request: a command for a check, then its result as the answer. */
export function scriptedTurn(body: Body): Turn {
  // M10 checklist: a chat or session is titled with its first message, so the test can find it.
  const system =
    typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text).join("");
  if (system.includes("Write a short title")) {
    const input = body.messages.flatMap((m) => blocks(m.content)).map((b) => b.text ?? "");
    const asked = /<user_message>\s*([^\n]+)/.exec(input.join("\n"))?.[1];
    return { text: (asked ?? "A chat").slice(0, 60) };
  }
  if (system.includes("<run_synthesis>")) {
    const content = body.messages.at(-1)?.content;
    const raw =
      typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("");
    const evidence = JSON.parse(raw) as { draftResult?: string };
    return { text: evidence.draftResult ?? "No draft result." };
  }
  const last = body.messages.at(-1);
  const result = last ? blocks(last.content).find((b) => b.type === "tool_result") : undefined;
  if (result) {
    const raw = resultText(result);
    if (raw.includes('tool="propose_memory"'))
      return { text: "The Context brief is saved. Your memory suggestion is waiting for review." };
    if (raw.includes('tool="search_artifacts"')) {
      const value = JSON.parse(raw.slice(raw.indexOf("\n") + 1, raw.lastIndexOf("\n"))) as {
        results: { versionId: string }[];
      };
      return {
        text: `Found the saved Context brief by keyword. Source: this conversation. Version UUID: ${value.results[0]?.versionId ?? "not found"}.`,
      };
    }
    return { text: `Command result:\n\n${raw}` };
  }
  const lastAsked = askedIn(body);
  // M17 context fixture: shared production handlers and real isolated SQLite; no provider call.
  if (lastAsked?.includes("E2E context draft")) {
    return {
      text: "I will save the app draft and propose a preference for review.",
      calls: [
        {
          name: "propose_memory",
          input: { operation: "add", kind: "preference", text: "Prefers concise chapters" },
        },
        {
          name: "create_artifact",
          input: {
            key: "context-brief",
            title: "Context brief",
            type: "markdown",
            content: "# Quiet roads\n\nA short chapter about electric cars and careful journeys.",
          },
        },
      ].filter((c) => body.tools?.some((t) => t.name === c.name)),
    };
  }
  // M17.2 canvas fixture: a document, then a reviewed Shorten proposal for its Risks section.
  const latest = body.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => blocks(m.content))
    .map((b) => b.text ?? "")
    .findLast((t) => t.trim() !== "");
  if (latest?.includes('Edit the artifact "Canvas plan"'))
    return {
      text: '<artifact id="canvas-plan" type="markdown" title="Canvas plan">\n# Canvas plan\n\nShip the writing canvas.\n\n## Risks\n\nEdits can clash.\n</artifact>\nHere is the shorter Risks section.',
    };
  if (lastAsked?.includes("E2E canvas draft"))
    return {
      text: '<artifact id="canvas-plan" type="markdown" title="Canvas plan">\n# Canvas plan\n\nShip the writing canvas.\n\n## Risks\n\nTwo people can edit the same document at once, and a reply that started earlier could overwrite newer work.\n</artifact>\nThe plan is ready.',
    };
  if (lastAsked?.includes("E2E context search"))
    return {
      calls: body.tools?.some((t) => t.name === "search_artifacts")
        ? [{ name: "search_artifacts", input: { query: "electric", meaning: false } }]
        : [],
    };
  // M9 step 12: "E2E fetch" reads a public page through fetch_url.
  if (lastAsked?.includes("E2E fetch")) {
    if (!body.tools?.length) return { text: "1. Read the page." };
    if (!body.tools.some((t) => t.name === "fetch_url"))
      return { text: "fetch_url wasn't offered." };
    return { calls: [{ name: "fetch_url", input: { url: "https://example.com/" } }] };
  }
  // M10 checklist (e2e/checklist.e2e.ts): a Code session's run writes one file, for the Files
  // panel and its Undo. "E2E slow" and "E2E stall" answer like any other ask; scriptedFetch
  // holds them back.
  if (lastAsked?.includes("E2E edit")) {
    if (!body.tools?.length) return { text: "1. Write checklist.txt." };
    if (!body.tools.some((t) => t.name === "write_file"))
      return { text: "write_file wasn't offered." };
    return {
      calls: [
        {
          name: "write_file",
          input: { path: "checklist.txt", content: "Made by the checklist.\n" },
        },
      ],
    };
  }
  if (lastAsked?.includes("E2E python")) {
    // The planner asks without tools: it gets a plan.
    if (!body.tools?.length) return { text: "1. Run the script with run_python." };
    if (!body.tools.some((t) => t.name === "run_python")) {
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

/** The task a request is for: the last user text that names an E2E script. */
const askedIn = (body: Body) =>
  body.messages
    .flatMap((m) => (m.role === "user" ? blocks(m.content) : []))
    .map((b) => b.text ?? "")
    .findLast((t) => t.includes("E2E "));

/**
 * M10 checklist: "E2E slow" answers after 6 s, so the sidebar shows the run going; "E2E stall"
 * never answers, so the watchdog stops the run. Both end early when the run is stopped.
 */
function held(body: Body, signal: AbortSignal | undefined): Promise<void> {
  const asked = askedIn(body);
  const ms = asked?.includes("E2E stall") ? Infinity : asked?.includes("E2E slow") ? 6000 : 0;
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = ms === Infinity ? undefined : setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

let turns = 0;
const scriptedFetch: FetchLike = async (url, init) => {
  if (init.method === "GET") {
    return Response.json({
      data: [
        { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
        { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
        { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
      ],
      has_more: false,
    });
  }
  if (!url.endsWith("/v1/messages")) return new Response("{}", { status: 404 });
  const body = JSON.parse(init.body ?? "{}") as Body;
  await held(body, init.signal);
  const turn = scriptedTurn(body);
  // For e2e/screenshots/console.log: which request got which turn, when.
  console.info(
    `e2e request ${String(turns + 1)}: ${String(body.messages.length)} messages, ${body.tools?.length ? "tools" : "no tools"} -> ${turn.calls?.length ? "tool call" : "text"}`,
  );
  return new Response(anthropicTurn(turn, ++turns), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

const keysApi: KeysApi = {
  status: (p) =>
    Promise.resolve(
      p === "anthropic" ||
        localStorage.getItem("fuse.e2e.dictation") === "yes" ||
        localStorage.getItem("fuse.e2e.research") === "yes"
        ? { saved: true, masked: "e2e…test" }
        : { saved: false, masked: null },
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
    batch: (statements) => slow("atomic batch", () => db.batch(statements)),
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

// Explicit test-only opt-in; no microphone, provider endpoint or real secret is touched.
const dictation: DictationApi = {
  start: (_consent, signal) => {
    if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    const at = performance.now();
    return Promise.resolve({
      status: () =>
        Promise.resolve({
          phase: "recording",
          durationMs: Math.min(120000, Math.floor(performance.now() - at)),
          bytes: 16044,
        }),
      stop: () => Promise.resolve(encodeRecording([new Float32Array(8000)], 8000)),
      cancel: () => Promise.resolve(),
    });
  },
  transcribe: async (bytes, scope, _consent, signal) => {
    try {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const db = await openTauriDb();
      const requestId = await logRequest(db, DEFAULT_TENANT, {
        threadId: scope.startsWith("thread:") ? scope.slice(7) : null,
        projectId: scope.startsWith("project:") ? scope.slice(8) : null,
        messageId: null,
        purpose: "transcribe",
        provider: "openai",
        model: "gpt-transcribe",
        attempt: 1,
        usage: { ...EMPTY_USAGE, costMicroUsd: 75 },
        billingState: "reported",
        audioDurationMs: 1000,
        httpStatus: 200,
        errorCode: null,
        errorMessage: null,
        providerRequestId: null,
      });
      return {
        requestId,
        text: "A dictated fixture, ready to edit.",
        durationMs: 1000,
        billingState: "reported",
        costMicroUsd: 75,
        boundMicroUsd: 75,
      };
    } finally {
      bytes.fill(0);
    }
  },
};

let reviewSeed: Promise<SqlDb> | undefined;
const openReviewSeed = () =>
  (reviewSeed ??= (async () => {
    const db = await loggedDb();
    const project = await createProject(db, DEFAULT_TENANT, "Review fixture");
    await setProjectRepo(db, DEFAULT_TENANT, project.id, { root: FOLDER, readSecrets: false });
    await createThread(db, DEFAULT_TENANT, "Recorded review workspace", project.id, false, "code");
    return db;
  })());
let scriptSeed: Promise<SqlDb> | undefined;
let parallelSeed: Promise<SqlDb> | undefined;
const openParallelSeed = () =>
  (parallelSeed ??= (async () => {
    const db = await loggedDb();
    const saved = localStorage.getItem("fuse.e2e.parallelProject");
    if (saved && (await getProject(db, DEFAULT_TENANT, saved))) return db;
    const project = await createProject(db, DEFAULT_TENANT, "Parallel fixture");
    await setProjectRepo(db, DEFAULT_TENANT, project.id, { root: FOLDER, readSecrets: false });
    await setProjectRunMode(db, DEFAULT_TENANT, project.id, "ask");
    await setProjectRunLimits(db, DEFAULT_TENANT, project.id, { capMicroUsd: 5_000_000 });
    localStorage.setItem("fuse.e2e.parallelProject", project.id);
    if (isDesktop()) {
      const thread = await createThread(
        db,
        DEFAULT_TENANT,
        "Recorded parallel workspace",
        project.id,
        false,
        "code",
      );
      localStorage.setItem("fuse.lastThread.code", thread.id);
      localStorage.setItem("fuse.area", "code");
    }
    return db;
  })());
const openScriptSeed = () =>
  (scriptSeed ??= (async () => {
    const db = await loggedDb();
    const project = await createProject(db, DEFAULT_TENANT, "Skill script fixture");
    await setProjectRepo(db, DEFAULT_TENANT, project.id, { root: FOLDER, readSecrets: false });
    const skill = await importSkill(db, DEFAULT_TENANT, {
      name: "calculate",
      projectId: project.id,
      localOnly: true,
      package: await readSkillPackage(
        "calculate.zip",
        zipSync({
          "SKILL.md": strToU8("Run calculate.py only when explicitly asked."),
          "data.txt": strToU8("21"),
          "scripts/calculate.py": strToU8(
            "import os,sys\nprint('Literal argument:',sys.argv[1])\nprint('Result:',int(open(os.path.join(os.path.dirname(__file__),'..','data.txt')).read())*2)\nopen(os.path.join(os.environ['FUSE_OUT'],'result.txt'),'w').write('42')\n",
          ),
        }),
      ),
    });
    localStorage.setItem("fuse.e2e.skillPin", `/skill calculate@${skill.versionId}`);
    if (isDesktop()) {
      const thread = await createThread(
        db,
        DEFAULT_TENANT,
        "Approved script fixture",
        project.id,
        false,
        "code",
      );
      localStorage.setItem("fuse.lastThread.code", thread.id);
      localStorage.setItem("fuse.area", "code");
    }
    return db;
  })());
let skillsSeed: Promise<SqlDb> | undefined;
const openSkillsSeed = () =>
  (skillsSeed ??= (async () => {
    const db = await loggedDb();
    await importSkill(db, DEFAULT_TENANT, {
      name: "release-notes",
      projectId: null,
      localOnly: false,
      package: await readSkillPackage(
        "SKILL.md",
        new TextEncoder().encode(
          "# Release notes\n\nWrite concise notes with evidence and limitations. Supporting scripts never grant permission.",
        ),
      ),
    });
    return db;
  })());
export function e2eDeps() {
  if (import.meta.env.VITE_E2E_SKILLS_SEED === "1")
    window.location.hash = "#settings/personalization/skills";
  if (import.meta.env.VITE_E2E_RESEARCH === "1") localStorage.setItem("fuse.e2e.research", "yes");
  if (import.meta.env.VITE_E2E_DICTATION === "1") localStorage.setItem("fuse.e2e.dictation", "yes");
  // The test checks this before it clicks anything, so it never drives a real build.
  document.documentElement.dataset.build = E2E_MARK;
  const anthropic = logged(createAnthropicAdapter({ fetch: scriptedFetch }));
  const connectors = scriptedConnectorsApi(loggedDb, DEFAULT_TENANT, { pollAfterSeconds: 3 });
  let connectorSeed: Promise<SqlDb> | undefined;
  const openConnectorSeed = () =>
    (connectorSeed ??= (async () => {
      const db = await loggedDb();
      const project = await createProject(db, DEFAULT_TENANT, "Connector fixture");
      localStorage.removeItem("fuse.e2e.connectorOutcome");
      localStorage.setItem("fuse.e2e.connectorAccount", "work");
      const registration = {
        ...DEFAULT_TENANT,
        id: "00000000-0000-7000-8000-000000001504",
        kind: "microsoft" as const,
        clientId: "10000000-0000-4000-8000-000000000001",
        tenant: "common",
        services: ["onedrive", "mail", "calendar"] as ("onedrive" | "mail" | "calendar")[],
      };
      await connectors.configure(registration);
      const flow = await connectors.begin(registration.id);
      if (!flow.flowId) throw new Error("Missing synthetic connector flow.");
      const status = await connectors.poll(registration.id, flow.flowId);
      await connectors.projectAccess(registration, project.id, status.identity, true);
      return db;
    })());
  if (import.meta.env.VITE_E2E_CONNECTORS_SEED === "1")
    window.location.hash = "#settings/code-tools/connectors";
  const openai = createOpenAIAdapter({
    fetch: (_url, init) =>
      init.method === "GET"
        ? Promise.resolve(
            Response.json({
              data: defaultCatalog.models
                .filter((m) => m.provider === "openai")
                .map((m) => ({ id: m.id })),
            }),
          )
        : Promise.reject(new Error("OpenAI model calls are disabled in the dictation fixture.")),
  });
  return {
    ...(import.meta.env.VITE_E2E_SKILL_SCRIPT === "1" && isDesktop()
      ? {
          exec: {
            ...tauriExec,
            sandboxKind: () => Promise.resolve("bubblewrap" as const),
            skillPython: () =>
              Promise.resolve({
                output: "Result: 42\n",
                exitCode: 0,
                timedOut: false,
                stopped: false,
                truncated: false,
                elapsedMs: 1,
                files: [],
                skipped: [],
              }),
          },
          python: {
            ...tauriPythonApi,
            status: () =>
              Promise.resolve({
                python: "fixture",
                release: "fixture",
                packages: [],
                sizeBytes: 0,
                installedMs: 0,
              }),
          },
        }
      : {}),
    connectors,
    dictation,
    web: scriptedResearchWeb(tauriWebApi),
    hulk,
    keysApi,
    updates,
    openDb:
      import.meta.env.VITE_E2E_PARALLEL === "1"
        ? openParallelSeed
        : import.meta.env.VITE_E2E_SKILL_SCRIPT === "1"
          ? openScriptSeed
          : import.meta.env.VITE_E2E_SKILLS_SEED === "1"
            ? openSkillsSeed
            : import.meta.env.VITE_E2E_REVIEW_SEED === "1"
              ? openReviewSeed
              : import.meta.env.VITE_E2E_CONNECTORS_SEED === "1"
                ? openConnectorSeed
                : loggedDb,
    repo,
    adapterFor: (p: ProviderId): ProviderAdapter => {
      const base = p === "anthropic" ? anthropic : openai;
      if (import.meta.env.VITE_E2E_PARALLEL === "1") return recordedParallelAdapter(p, base);
      if (import.meta.env.VITE_E2E_SKILL_SCRIPT === "1") return recordedSkillAdapter(p, base);
      if (import.meta.env.VITE_E2E_REVIEW_SEED === "1") return recordedReviewAdapter(p, base);
      return localStorage.getItem("fuse.e2e.research") === "yes"
        ? scriptedResearchAdapter(p, { base, delayMs: 700 })
        : base;
    },
  };
}
