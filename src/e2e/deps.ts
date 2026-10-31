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

interface Block {
  type: string;
  text?: string;
  content?: string | { type: string; text?: string }[];
}
interface Body {
  messages: { role: string; content: string | Block[] }[];
  tools?: unknown[];
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

export function e2eDeps() {
  // The test checks this before it clicks anything, so it never drives a real build.
  document.documentElement.dataset.build = E2E_MARK;
  const anthropic = createAnthropicAdapter({ fetch: scriptedFetch });
  return {
    keysApi,
    updates,
    repo,
    adapterFor: (p: ProviderId): ProviderAdapter => {
      if (p !== "anthropic") throw new Error(`${p} isn't scripted in the test build.`);
      return anthropic;
    },
  };
}
