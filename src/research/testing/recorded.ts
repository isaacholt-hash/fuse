/** Synthetic wire recordings through the real adapters. Never imported by release entrypoints. */
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { anthropicTurn } from "@/agent/testing/turns";
import type { FetchLike, ProviderAdapter } from "@/providers/types";
import type { ProviderId } from "@/catalog/catalog";
import { RESEARCH_FIXTURE_URL } from "./scripted";
export interface RecordedCall {
  provider: ProviderId;
  model: string;
  stage: "plan" | "search" | "synthesis" | "verify";
  system: string;
  body: string;
}
const event = (value: Record<string, unknown>) =>
  `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`;
const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const stopped = () => {
      clearTimeout(timer);
      reject(new DOMException("Fixture aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stopped);
      resolve();
    }, ms);
    if (signal?.aborted) stopped();
    else signal?.addEventListener("abort", stopped, { once: true });
  });
export function recordedResearchAdapters(
  options: {
    delayMs?: number;
    queries?: string[];
    ambiguousAt?: number;
    onCall?: (call: RecordedCall, index: number) => void;
  } = {},
) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as {
      model: string;
      instructions?: string;
      system?: string;
      tools?: { type?: string }[];
    };
    const provider = url.includes("api.anthropic.com") ? "anthropic" : "openai";
    const system = body.instructions ?? body.system ?? "";
    const search = Boolean(body.tools?.some((t) => t.type?.startsWith("web_search")));
    const stage = system.includes("<research_plan>")
      ? "plan"
      : search
        ? "search"
        : system.includes("<research_support_review>")
          ? "verify"
          : "synthesis";
    const call: RecordedCall = {
      provider,
      model: body.model,
      stage,
      system,
      body: init.body ?? "",
    };
    calls.push(call);
    options.onCall?.(call, calls.length);
    await delay(options.delayMs ?? 1, init.signal);
    if (options.ambiguousAt === calls.length)
      throw new TypeError("Fixture: connection lost after dispatch");
    const text =
      stage === "plan"
        ? JSON.stringify({ queries: options.queries ?? ["Recorded tide measurement"] })
        : stage === "search"
          ? "The recorded measurement is two metres."
          : stage === "verify"
            ? JSON.stringify({
                claims: [
                  { id: "C1", supported: true },
                  { id: "C2", supported: true },
                ],
              })
            : JSON.stringify({
                title: "Recorded research report",
                claims: [
                  {
                    text: "The recorded measurement is two metres.",
                    evidence: [
                      { sourceId: "S1", quote: "The recorded measurement is two metres." },
                    ],
                  },
                  {
                    text: "An unsupported synthetic assertion.",
                    evidence: [{ sourceId: "invented", quote: "Not collected." }],
                  },
                ],
                limitations: ["Synthetic fixture; no provider or search service was called."],
                disagreements: [
                  "Only one measurement is represented; no broader agreement is established.",
                ],
              });
    let stream: string;
    if (provider === "anthropic") {
      if (search)
        throw new Error("The bounded research fixture never dispatches Anthropic hosted search.");
      stream = anthropicTurn({ text }, calls.length);
    } else {
      const searchItem = {
        type: "web_search_call",
        id: `search-${String(calls.length)}`,
        action: {
          type: "search",
          query: "Recorded tide measurement",
          sources: [{ url: RESEARCH_FIXTURE_URL, title: "Recorded measurements" }],
        },
      };
      stream =
        event({ type: "response.output_text.delta", delta: text }) +
        (search ? event({ type: "response.output_item.done", item: searchItem }) : "") +
        event({
          type: "response.completed",
          response: {
            usage: { input_tokens: 1000, output_tokens: 100 },
            output: search ? [searchItem] : [],
            ...(search ? { tool_usage: { web_search: { num_requests: 1 } } } : {}),
          },
        });
    }
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": `fixture-${String(calls.length)}`,
        "request-id": `fixture-${String(calls.length)}`,
      },
    });
  };
  const openai = createOpenAIAdapter({ fetch }),
    anthropic = createAnthropicAdapter({ fetch });
  const adapterFor = (provider: ProviderId): ProviderAdapter => {
    if (provider === "openai") return openai;
    if (provider === "anthropic") return anthropic;
    throw new Error("Local models remain housekeeping only.");
  };
  return { adapterFor, calls };
}
