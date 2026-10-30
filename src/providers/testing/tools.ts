// Test-only: the tool and fake repository the tool fixtures were recorded with
// (scripts/record-fixtures.ts, M6 step 2).
import type { ToolCall, ToolResult, ToolSpec } from "../types";

export const READ_FILE: ToolSpec = {
  name: "read_file",
  description:
    "Read a text file from the repository and return its contents. Use it whenever you need to " +
    "know what a file says. The path is relative to the repository root.",
  schema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to the repository root." } },
    required: ["path"],
    additionalProperties: false,
  },
};

const FILES: Record<string, string> = {
  "README.md": "# Lighthouse\n\nA tiny command-line tool that prints the tide table.\n",
  "a.txt": "17\n",
  "b.txt": "25\n",
};

export function runFakeTool(call: ToolCall): ToolResult {
  const path = typeof call.input.path === "string" ? call.input.path : "";
  const content = Object.hasOwn(FILES, path) ? FILES[path] : undefined;
  return content === undefined
    ? { callId: call.id, content: `Error: no such file: ${path}`, isError: true }
    : { callId: call.id, content, isError: false };
}

/** The scenarios, with the user's question each was recorded with. */
export const TOOL_SCENARIOS = [
  {
    name: "tool-call",
    ask: "Read README.md and tell me the project's name in one word.",
    answer: "Lighthouse",
  },
  {
    name: "tool-parallel",
    ask: "Read a.txt and b.txt (both at once), then reply with only the sum of the two numbers.",
    answer: "42",
  },
  { name: "tool-error", ask: "Read notes.txt and tell me what it says.", answer: null },
  {
    name: "tool-reasoning",
    ask: "Read README.md and tell me the project's name in one word.",
    answer: "Lighthouse",
  },
] as const;
