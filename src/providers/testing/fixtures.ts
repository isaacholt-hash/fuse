// Test-only loader for the recorded provider fixtures (scripts/record-fixtures.ts, M0 step 5a).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeResponse } from "./fakeFetch";

export interface FixtureMeta {
  scenario: string;
  status: number;
  response_headers: Record<string, string>;
  request_body: Record<string, unknown>;
  aborted_by_client: boolean;
}

/** A recorded scenario as a FakeResponse, replayed exactly as the provider sent it. */
export function loadFixture(
  provider: "anthropic" | "openai",
  scenario: string,
): { meta: FixtureMeta; response: FakeResponse } {
  const dir = join(import.meta.dirname, "..", provider, "fixtures");
  const meta = JSON.parse(readFileSync(join(dir, `${scenario}.meta.json`), "utf8")) as FixtureMeta;
  const sse = join(dir, `${scenario}.sse`);
  const body = readFileSync(existsSync(sse) ? sse : join(dir, `${scenario}.json`), "utf8");
  return { meta, response: { status: meta.status, headers: meta.response_headers, body } };
}
