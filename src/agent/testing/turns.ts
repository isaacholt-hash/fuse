// Test-only: scripted model turns streamed as Anthropic and OpenAI stream them (M6 step 13), so a
// benchmark runs through the real adapters with no API calls.
import type { ToolCall } from "@/providers/types";

export interface Turn {
  text?: string;
  calls?: Omit<ToolCall, "id">[];
}

const usage = { input_tokens: 1000, output_tokens: 100 };
const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** A turn as Anthropic streams it. */
export function anthropicTurn(turn: Turn, n: number): string {
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } },
  ];
  let i = 0;
  if (turn.text) {
    events.push({
      type: "content_block_start",
      index: i,
      content_block: { type: "text", text: "" },
    });
    events.push({
      type: "content_block_delta",
      index: i,
      delta: { type: "text_delta", text: turn.text },
    });
    events.push({ type: "content_block_stop", index: i++ });
  }
  (turn.calls ?? []).forEach((c, k) => {
    events.push({
      type: "content_block_start",
      index: i,
      content_block: {
        type: "tool_use",
        id: `toolu_${String(n)}_${String(k)}`,
        name: c.name,
        input: {},
      },
    });
    const json = JSON.stringify(c.input);
    // Arguments arrive in pieces, as they do for real.
    for (const part of [json.slice(0, 10), json.slice(10)]) {
      events.push({
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: part },
      });
    }
    events.push({ type: "content_block_stop", index: i++ });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: turn.calls?.length ? "tool_use" : "end_turn" },
    usage: { output_tokens: 100 },
  });
  events.push({ type: "message_stop" });
  return sse(events);
}

/** A turn as OpenAI's Responses API streams it. */
export function openaiTurn(turn: Turn, n: number): string {
  const events: Record<string, unknown>[] = [{ type: "response.created", response: {} }];
  const output: Record<string, unknown>[] = [];
  if (turn.text) {
    events.push({ type: "response.output_text.delta", delta: turn.text });
    const item = {
      type: "message",
      id: `msg_${String(n)}`,
      role: "assistant",
      phase: turn.calls?.length ? "commentary" : "final_answer",
      content: [{ type: "output_text", text: turn.text }],
    };
    events.push({ type: "response.output_item.done", item });
    output.push(item);
  }
  (turn.calls ?? []).forEach((c, k) => {
    const item = {
      type: "function_call",
      id: `fc_${String(n)}_${String(k)}`,
      call_id: `call_${String(n)}_${String(k)}`,
      name: c.name,
      arguments: JSON.stringify(c.input),
    };
    events.push({ type: "response.output_item.done", item });
    output.push(item);
  });
  events.push({ type: "response.completed", response: { usage, output } });
  return sse(events);
}
