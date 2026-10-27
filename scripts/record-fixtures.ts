// Records real provider responses as test fixtures for the adapters (M0 step 5a).
//
// Isaac runs this once, with keys from his own shell (never a file):
//   FUSE_ANTHROPIC_API_KEY=… FUSE_OPENAI_API_KEY=… pnpm record-fixtures
// (or with both already exported). Either key may be missing; that provider is skipped.
//
// Safety:
// - Keys are read from the environment only and never printed.
// - Only an allowlist of response headers is saved.
// - Before writing, every file is checked for the key and for key-shaped strings; if found, the
//   script aborts without writing anything.
// Cost: a handful of tiny requests on the cheapest models, well under $0.01 in total.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type ProviderName = "anthropic" | "openai";

interface Scenario {
  name: string;
  description: string;
  provider: ProviderName;
  model: string;
  body: Record<string, unknown>;
  /** Send this instead of the real key (error fixtures). */
  fakeKey?: string;
  /** Abort the stream after this many bytes (stop-button fixture). */
  abortAfterBytes?: number;
}

const ROOT = join(import.meta.dirname, "..");
const ANTHROPIC_VERSION = "2026-10-21"; // docs/providers.md
const KEPT_HEADERS = [
  "content-type",
  "request-id",
  "x-request-id",
  "retry-after",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-tokens-limit",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
];
const INVALID_KEY = "fuse-fixture-invalid-key-0000000000";
const KEY_SHAPED = /sk-[A-Za-z0-9_-]{20,}|sk-ant-/;

const anthropicBody = (model: string, messages: unknown[], maxTokens = 200) => ({
  model,
  max_tokens: maxTokens,
  stream: true,
  messages,
});
const openaiBody = (model: string, input: unknown[], maxOutput = 300) => ({
  model,
  input,
  stream: true,
  store: false,
  service_tier: "default",
  max_output_tokens: maxOutput,
});

const HELLO = "Reply with exactly: Hello from FUSE.";
const HISTORY = [
  { role: "user", content: "My name is Isaac. Remember it." },
  { role: "assistant", content: "Got it, Isaac." },
  { role: "user", content: "What is my name? Answer in one word." },
];
const REASON = "What is 17 × 23? Think it through, then give only the number.";

const SCENARIOS: Scenario[] = [
  // Anthropic
  {
    name: "text",
    description: "Short plain answer",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    body: anthropicBody("claude-haiku-5-5", [{ role: "user", content: HELLO }]),
  },
  {
    name: "multi-turn",
    description: "Three-message history",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    body: anthropicBody("claude-haiku-5-5", HISTORY),
  },
  {
    name: "reasoning",
    description: "Thinking tokens on a reasoning model",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    body: anthropicBody("claude-sonnet-5-5", [{ role: "user", content: REASON }], 2000),
  },
  {
    name: "aborted",
    description: "Client stops reading early (stop button)",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    body: anthropicBody(
      "claude-haiku-5-5",
      [{ role: "user", content: "Count from 1 to 200, one number per line." }],
      1500,
    ),
    abortAfterBytes: 1500,
  },
  {
    name: "error-401",
    description: "Invalid API key",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    body: anthropicBody("claude-haiku-5-5", [{ role: "user", content: HELLO }]),
    fakeKey: INVALID_KEY,
  },
  {
    name: "error-unknown-model",
    description: "Model id that does not exist",
    provider: "anthropic",
    model: "fuse-no-such-model",
    body: anthropicBody("fuse-no-such-model", [{ role: "user", content: HELLO }]),
  },
  {
    name: "error-temperature",
    description: "temperature is rejected under anthropic-version 2026-10-21",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    body: {
      ...anthropicBody("claude-haiku-5-5", [{ role: "user", content: HELLO }]),
      temperature: 0.5,
    },
  },
  // OpenAI
  {
    name: "text",
    description: "Short plain answer",
    provider: "openai",
    model: "gpt-6-luna",
    body: openaiBody("gpt-6-luna", [{ role: "user", content: HELLO }]),
  },
  {
    name: "multi-turn",
    description: "Three-message history",
    provider: "openai",
    model: "gpt-6-luna",
    body: openaiBody("gpt-6-luna", HISTORY),
  },
  {
    name: "reasoning",
    description: "Reasoning tokens on a reasoning model",
    provider: "openai",
    model: "gpt-6.1-sol",
    body: openaiBody("gpt-6.1-sol", [{ role: "user", content: REASON }], 2000),
  },
  {
    name: "incomplete",
    description: "Hits max_output_tokens (response.incomplete)",
    provider: "openai",
    model: "gpt-6-luna",
    body: openaiBody(
      "gpt-6-luna",
      [{ role: "user", content: "Write a 500-word story about a lighthouse." }],
      40,
    ),
  },
  {
    name: "aborted",
    description: "Client stops reading early (stop button)",
    provider: "openai",
    model: "gpt-6-luna",
    body: openaiBody(
      "gpt-6-luna",
      [{ role: "user", content: "Count from 1 to 200, one number per line." }],
      1500,
    ),
    abortAfterBytes: 1500,
  },
  {
    name: "error-401",
    description: "Invalid API key",
    provider: "openai",
    model: "gpt-6-luna",
    body: openaiBody("gpt-6-luna", [{ role: "user", content: HELLO }]),
    fakeKey: INVALID_KEY,
  },
  {
    name: "error-unknown-model",
    description: "Model id that does not exist",
    provider: "openai",
    model: "fuse-no-such-model",
    body: openaiBody("fuse-no-such-model", [{ role: "user", content: HELLO }]),
  },
];

function endpoint(p: ProviderName): string {
  return p === "anthropic"
    ? "https://api.anthropic.com/v1/messages"
    : "https://api.openai.com/v1/responses";
}

function headersFor(p: ProviderName, key: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  if (p === "anthropic") h["anthropic-version"] = ANTHROPIC_VERSION;
  return h;
}

interface Recorded {
  path: string;
  content: string;
}

async function record(s: Scenario, key: string): Promise<Recorded[]> {
  const controller = new AbortController();
  const started = Date.now();
  const res = await fetch(endpoint(s.provider), {
    method: "POST",
    headers: headersFor(s.provider, s.fakeKey ?? key),
    body: JSON.stringify(s.body),
    signal: controller.signal,
  });
  let body = "";
  let aborted = false;
  if (res.body) {
    const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
      if (s.abortAfterBytes !== undefined && body.length >= s.abortAfterBytes) {
        aborted = true;
        controller.abort();
        break;
      }
    }
    body += decoder.decode();
  }
  const kept: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) kept[name] = v;
  }
  const meta = {
    scenario: s.name,
    description: s.description,
    provider: s.provider,
    recorded_on: new Date().toISOString().slice(0, 10),
    endpoint: endpoint(s.provider),
    request_headers: s.provider === "anthropic" ? { "anthropic-version": ANTHROPIC_VERSION } : {},
    request_body: s.body,
    used_invalid_key: s.fakeKey !== undefined,
    status: res.status,
    response_headers: kept,
    aborted_by_client: aborted,
    elapsed_ms: Date.now() - started,
  };
  const dir = join(ROOT, "src", "providers", s.provider, "fixtures");
  const ext = (res.headers.get("content-type") ?? "").includes("event-stream") ? "sse" : "json";
  return [
    { path: join(dir, `${s.name}.${ext}`), content: body },
    { path: join(dir, `${s.name}.meta.json`), content: `${JSON.stringify(meta, null, 2)}\n` },
  ];
}

async function main(): Promise<void> {
  const keys: Partial<Record<ProviderName, string>> = {
    anthropic: process.env.FUSE_ANTHROPIC_API_KEY?.trim(),
    openai: process.env.FUSE_OPENAI_API_KEY?.trim(),
  };
  const files: Recorded[] = [];
  for (const p of ["anthropic", "openai"] as const) {
    const key = keys[p];
    if (!key) {
      console.log(`Skipping ${p}: FUSE_${p.toUpperCase()}_API_KEY is not set.`);
      continue;
    }
    for (const s of SCENARIOS.filter((x) => x.provider === p)) {
      process.stdout.write(`${p}/${s.name} … `);
      try {
        const out = await record(s, key);
        const meta = JSON.parse(out[1]?.content ?? "{}") as { status: number };
        console.log(`HTTP ${String(meta.status)}`);
        files.push(...out);
      } catch (e) {
        console.log(`failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Refuse to write anything that contains a key or looks like one.
  const secrets = Object.values(keys).filter((k): k is string => Boolean(k));
  for (const f of files) {
    if (secrets.some((k) => f.content.includes(k)) || KEY_SHAPED.test(f.content)) {
      console.error(`ABORTED: ${f.path} would contain a key-like string. Nothing was written.`);
      process.exit(1);
    }
  }
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
  }
  console.log(`\nWrote ${String(files.length)} files under src/providers/*/fixtures/.`);
  console.log("Next: tell Claude the fixtures are recorded. Don't edit them by hand.");
}

await main();
