// @vitest-environment node
// WF-03: a tool result with an image, in each provider's shape.
import type { ChatMessage, NativeTurn } from "./types";
import { buildRequestBody as anthropicBody } from "./anthropic/adapter";
import { buildRequestBody as openaiBody } from "./openai/adapter";

const turn = (provider: "anthropic" | "openai"): NativeTurn => ({
  provider,
  model: "m",
  items: [],
});
const history = (provider: "anthropic" | "openai"): ChatMessage[] => [
  { role: "user", content: "What's in photo.png?" },
  { role: "assistant", content: "", native: turn(provider) },
  {
    role: "user",
    content: "",
    toolResults: [
      {
        callId: "c1",
        content: "photo.png: an image (image/png, 1 KB), shown below.",
        isError: false,
        images: [{ mime: "image/png", data: "iVBORw0KGgo=" }],
      },
    ],
  },
];

test("Anthropic: a tool_result holding text, then an image block", () => {
  const body = anthropicBody(history("anthropic"), "m", {}) as { messages: { content: unknown }[] };
  const last = body.messages.at(-1)?.content as Record<string, unknown>[];
  expect(last[0]).toMatchObject({
    type: "tool_result",
    tool_use_id: "c1",
    content: [
      { type: "text", text: "photo.png: an image (image/png, 1 KB), shown below." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ],
  });
});

test("OpenAI: a function_call_output holding input_text, then an input_image", () => {
  const body = openaiBody(history("openai"), "m", {}) as { input: Record<string, unknown>[] };
  const out = body.input.find((i) => i.type === "function_call_output");
  expect(out).toMatchObject({
    call_id: "c1",
    output: [
      { type: "input_text", text: "photo.png: an image (image/png, 1 KB), shown below." },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
    ],
  });
});

test("without images, results stay plain text on both", () => {
  const plain: ChatMessage[] = history("anthropic").map((m) =>
    m.toolResults ? { ...m, toolResults: m.toolResults.map(({ images: _i, ...r }) => r) } : m,
  );
  const a = anthropicBody(plain, "m", {}) as { messages: { content: unknown }[] };
  expect((a.messages.at(-1)?.content as Record<string, unknown>[])[0]?.content).toBe(
    "photo.png: an image (image/png, 1 KB), shown below.",
  );
});
