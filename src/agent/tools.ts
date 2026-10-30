// The coding agent's read-only tools (M6 step 5, CA-01). One strict schema each, written to
// OpenAI's rules so both providers get the same definition (docs/providers.md, M6). The list is
// fixed for a whole run, in this order, so the prompt cache holds.
import type { RepoApi } from "@/repo/api";
import type { ToolCall, ToolSpec } from "@/providers/types";

/** The most one result sends back; the rest is described, not sent (CA-08 refines this). */
export const MAX_TOOL_OUTPUT_CHARS = 40_000;

export const READ_ONLY_TOOLS: ToolSpec[] = [
  {
    name: "list_files",
    description:
      "List the files and folders in a folder of the repository. Use it to find your way " +
      "around before reading. Folders end with /. Files the repository ignores aren't listed. " +
      "Set recursive to true to list everything under the folder (capped at 2,000 entries).",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Folder relative to the root; "" for the root.' },
        recursive: {
          type: "boolean",
          description: "List everything under it, not just one level.",
        },
      },
      required: ["path", "recursive"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a text file from the repository. Long files come in parts of up to 256 KB: when a " +
      "result says there's more, call again with the offset it gives. Ignored files, binary " +
      "files and files that look like they hold secrets can't be read.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File relative to the repository root." },
        offset: {
          type: ["integer", "null"],
          description: "Byte offset to start from; null for the start.",
        },
      },
      required: ["path", "offset"],
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description:
      "Find lines containing some text, in the repository's text files. Returns path:line: text " +
      "for up to 200 matches. Use it to find where something is defined or used.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The exact text to look for." },
        path: {
          type: ["string", "null"],
          description: "Folder to search under; null for the whole repository.",
        },
        ignore_case: { type: "boolean", description: "Match regardless of case." },
      },
      required: ["query", "path", "ignore_case"],
      additionalProperties: false,
    },
  },
];

export interface ToolOutcome {
  output: string;
  isError: boolean;
  /** The folder the call worked in, so that folder's CLAUDE.md and AGENTS.md apply (CA-06). */
  folder: string | null;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const parent = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function capped(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[… ${String(text.length - MAX_TOOL_OUTPUT_CHARS)} more characters not shown; narrow the request]`;
}

/** Runs one call against the project's repository. Failures come back as results, not throws. */
export async function runTool(
  repo: RepoApi,
  projectId: string,
  call: ToolCall,
): Promise<ToolOutcome> {
  const input = call.input;
  try {
    switch (call.name) {
      case "list_files": {
        const path = str(input.path);
        const entries = await repo.list(projectId, path, input.recursive === true);
        const lines = entries.map((e) =>
          e.dir
            ? `${e.path}/`
            : `${e.path} (${String(e.size)} bytes${e.secret ? ", secret-looking" : ""})`,
        );
        return {
          output: capped(lines.length ? lines.join("\n") : "(empty)"),
          isError: false,
          folder: path,
        };
      }
      case "read_file": {
        const path = str(input.path);
        const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : 0;
        const f = await repo.read(projectId, path, offset);
        const end = f.offset + new TextEncoder().encode(f.content).length;
        const note = f.truncated
          ? `\n[bytes ${String(f.offset)}–${String(end)} of ${String(f.totalBytes)}; read again with offset ${String(end)} for the rest]`
          : f.offset > 0
            ? `\n[bytes ${String(f.offset)}–${String(end)} of ${String(f.totalBytes)}]`
            : "";
        return { output: capped(f.content) + note, isError: false, folder: parent(f.path) };
      }
      case "search_files": {
        const path = str(input.path);
        const hits = await repo.search(
          projectId,
          path,
          str(input.query),
          input.ignore_case === true,
        );
        const lines = hits.map((h) => `${h.path}:${String(h.line)}: ${h.text}`);
        return {
          output: capped(lines.length ? lines.join("\n") : "No matches."),
          isError: false,
          folder: path || null,
        };
      }
      default:
        return {
          output: `Error: there's no tool called ${call.name}.`,
          isError: true,
          folder: null,
        };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { output: `Error: ${message}`, isError: true, folder: null };
  }
}
