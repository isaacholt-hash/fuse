// The coding agent's read-only tools (M6 step 5, CA-01). One strict schema each, written to
// OpenAI's rules so both providers get the same definition (docs/providers.md, M6). The list is
// fixed for a whole run, in this order, so the prompt cache holds.
import { docKind, docxText, partOf, xlsxText } from "@/documents/read";
import { writeDocx, writePdf, writeXlsx, type Block, type SheetSpec } from "@/documents/write";
import { pageMarker } from "@/files/pdfText";
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

/** CA-02: the tools that change files, offered only when the run may edit (after the read-only
 * ones, in this order, for the whole run). */
/** WF-03: Word, Excel and PDF files as text, for Work runs. */
export const READ_DOCUMENT_TOOL: ToolSpec = {
  name: "read_document",
  description:
    "Read a document: Word (.docx) as text with headings, lists and tables; Excel (.xlsx) as a " +
    "table per sheet with cell references, values and formulas; PDF as text page by page; other " +
    "files as text. Long documents come in parts: call again with the offset the result gives. " +
    'For a big workbook, name a sheet and a range (e.g. "A1:F40").',
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file, from the folder's root." },
      offset: { type: ["integer", "null"], description: "Character offset; null for the start." },
      sheet: { type: ["string", "null"], description: "Excel only: one sheet; null for all." },
      range: { type: ["string", "null"], description: 'Excel only: e.g. "B2:D20"; null for all.' },
    },
    required: ["path", "offset", "sheet", "range"],
    additionalProperties: false,
  },
};

export const EDIT_TOOLS: ToolSpec[] = [
  {
    name: "edit_file",
    description:
      "Change part of an existing text file: old_text must appear in the file exactly once, " +
      "and is replaced by new_text. Read the file first and copy old_text exactly, with enough " +
      "lines around the change to be unique. Use write_file for new files.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File relative to the repository root." },
        old_text: {
          type: "string",
          description: "The exact text to replace (unique in the file).",
        },
        new_text: { type: "string", description: "What it becomes." },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create a text file, or replace a whole file's contents. Folders are created as needed. " +
      "Prefer edit_file for small changes to an existing file.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File relative to the repository root." },
        content: { type: "string", description: "The whole file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the repository.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File relative to the repository root." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file. It won't replace a file that's already there.",
    schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "The file now." },
        to: { type: "string", description: "Where it goes." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
];

/** WF-04: Word, Excel and PDF files from structured content, for Work runs. */
export const WRITE_DOCUMENT_TOOL: ToolSpec = {
  name: "write_document",
  description:
    "Create or replace a Word (.docx), Excel (.xlsx) or PDF (.pdf) file; the extension picks the " +
    "format. For Word and PDF give blocks (headings, paragraphs, bullet and numbered items, " +
    "tables whose first row is the header) and set sheets to null. For Excel give sheets (rows " +
    "of cells; a cell starting with = is a formula, e.g. =SUM(B2:B9); numbers are numbers) and " +
    "set blocks to null. The user sees a readable version of the document before or after.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file to write, from the folder's root." },
      title: { type: ["string", "null"], description: "Word and PDF: a title on top; or null." },
      blocks: {
        type: ["array", "null"],
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["heading", "paragraph", "bullet", "numbered", "table"] },
            text: { type: ["string", "null"], description: "Everything but tables." },
            level: { type: ["integer", "null"], description: "Headings: 1 to 3." },
            rows: {
              type: ["array", "null"],
              items: { type: "array", items: { type: "string" } },
              description: "Tables: rows of cells, the first row the header.",
            },
          },
          required: ["kind", "text", "level", "rows"],
          additionalProperties: false,
        },
      },
      sheets: {
        type: ["array", "null"],
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            rows: { type: "array", items: { type: "array", items: { type: "string" } } },
          },
          required: ["name", "rows"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "title", "blocks", "sheets"],
    additionalProperties: false,
  },
};

export const EDIT_TOOL_NAMES = new Set([
  ...EDIT_TOOLS.map((t) => t.name),
  WRITE_DOCUMENT_TOOL.name,
]);

/** The blocks of a write_document call, checked; bad ones are dropped rather than written. */
function blocksOf(input: Record<string, unknown>): Block[] {
  const raw = Array.isArray(input.blocks) ? (input.blocks as Record<string, unknown>[]) : [];
  return raw.flatMap((b): Block[] => {
    const text = typeof b.text === "string" ? b.text : "";
    switch (b.kind) {
      case "heading":
        return [{ kind: "heading", text, level: typeof b.level === "number" ? b.level : 1 }];
      case "paragraph":
      case "bullet":
      case "numbered":
        return [{ kind: b.kind, text }];
      case "table":
        return Array.isArray(b.rows)
          ? [{ kind: "table", rows: (b.rows as unknown[][]).map((r) => r.map((c) => String(c))) }]
          : [];
      default:
        return [];
    }
  });
}

/** The document a write_document call makes, and a readable version of it for the diff. */
export async function buildDocument(
  input: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; text: string }> {
  const path = str(input.path);
  const kind = docKind(path);
  const title = typeof input.title === "string" && input.title ? input.title : null;
  if (kind === "excel") {
    const sheets = (
      Array.isArray(input.sheets) ? (input.sheets as Record<string, unknown>[]) : []
    ).map((sh): SheetSpec => ({
      name: typeof sh.name === "string" ? sh.name : "Sheet",
      rows: Array.isArray(sh.rows)
        ? (sh.rows as unknown[][]).map((r) => r.map((c) => String(c)))
        : [],
    }));
    const bytes = writeXlsx(sheets);
    return { bytes, text: xlsxText(bytes) };
  }
  const blocks = blocksOf(input);
  if (kind === "word") {
    const bytes = writeDocx(title, blocks);
    return { bytes, text: docxText(bytes) };
  }
  if (kind === "pdf") {
    const bytes = await writePdf(title, blocks);
    // The same blocks as Word would read them back: what's in the PDF, in words.
    return { bytes, text: docxText(writeDocx(title, blocks)) };
  }
  throw new Error(
    `${path}: write_document makes .docx, .xlsx and .pdf files; use write_file for text.`,
  );
}

/** What a document holds now, in words (for the diff), or null when it isn't there. */
async function documentNow(repo: RepoApi, projectId: string, path: string) {
  if (!repo.readBytes) return null;
  const bytes = await repo.readBytes(projectId, path).catch(() => null);
  if (!bytes) return null;
  const kind = docKind(path);
  let text = "(a binary file)";
  try {
    if (kind === "word") text = docxText(bytes);
    else if (kind === "excel") text = xlsxText(bytes);
    else if (kind === "pdf") text = "(a PDF)";
  } catch {
    // Unreadable: the diff says so; the bytes are still kept for undo.
  }
  return { bytes, text };
}

const noInput = { type: "object", properties: {}, required: [], additionalProperties: false };

/** CA-05: git tools that only look. Offered in every mode. */
export const GIT_READ_TOOLS: ToolSpec[] = [
  {
    name: "git_status",
    description: "Show the current branch and which files are changed, staged or untracked.",
    schema: noInput,
  },
  {
    name: "git_diff",
    description:
      "Show changes not yet committed (or, with staged true, those staged for the next commit), " +
      "optionally for one path.",
    schema: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "Staged changes instead of unstaged ones." },
        path: { type: ["string", "null"], description: "Only this file or folder; null for all." },
      },
      required: ["staged", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "git_log",
    description: "Recent commits, one line each.",
    schema: {
      type: "object",
      properties: { count: { type: ["integer", "null"], description: "How many; null for 10." } },
      required: ["count"],
      additionalProperties: false,
    },
  },
];

/** CA-05: git tools that change things. Branch and commit work like edits; push and PR ask. */
export const GIT_WRITE_TOOLS: ToolSpec[] = [
  {
    name: "git_branch",
    description: "Create a new branch from the current commit and switch to it.",
    schema: {
      type: "object",
      properties: { name: { type: "string", description: "e.g. fix/tide-rounding" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "git_commit",
    description:
      "Commit changes with a message. With all true, every changed and new file is added first; " +
      "otherwise only what's already staged is committed. Write the message in the repository's style.",
    schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The commit message." },
        all: { type: "boolean", description: "Add every change first." },
      },
      required: ["message", "all"],
      additionalProperties: false,
    },
  },
  {
    name: "git_push",
    description:
      "Push the current branch to origin (setting it as upstream). The user is always asked first.",
    schema: noInput,
  },
  {
    name: "open_pull_request",
    description:
      "Open a pull request on GitHub for the current branch (push it first). The user is always asked first.",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "What changed, why, and how to test it." },
        draft: { type: "boolean" },
      },
      required: ["title", "body", "draft"],
      additionalProperties: false,
    },
  },
];

export const GIT_READ_NAMES = new Set(GIT_READ_TOOLS.map((t) => t.name));
/** Ask in Ask mode, go ahead in Auto-edit: local and undoable. */
export const GIT_LOCAL_NAMES = new Set(["git_branch", "git_commit"]);
/** Always ask: they leave this computer. */
export const GIT_REMOTE_NAMES = new Set(["git_push", "open_pull_request"]);

/** The git or gh arguments for a git tool call, or why it can't run. */
export function gitArgs(
  call: ToolCall,
): { program: "git" | "gh"; steps: string[][] } | { error: string } {
  const input = call.input;
  switch (call.name) {
    case "git_status":
      return { program: "git", steps: [["status", "--short", "--branch"]] };
    case "git_diff": {
      const args = ["diff", ...(input.staged === true ? ["--staged"] : [])];
      const path = str(input.path);
      return { program: "git", steps: [path ? [...args, "--", path] : args] };
    }
    case "git_log": {
      const n =
        typeof input.count === "number" && input.count > 0 ? Math.min(input.count, 100) : 10;
      return { program: "git", steps: [["log", "--oneline", "-n", String(n)]] };
    }
    case "git_branch": {
      const name = str(input.name).trim();
      if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("-") || name.includes("..")) {
        return { error: `Error: "${name}" isn't a usable branch name.` };
      }
      return { program: "git", steps: [["switch", "-c", name]] };
    }
    case "git_commit": {
      const message = str(input.message).trim();
      if (!message) return { error: "Error: a commit needs a message." };
      return {
        program: "git",
        steps: [...(input.all === true ? [["add", "-A"]] : []), ["commit", "-m", message]],
      };
    }
    case "git_push":
      return { program: "git", steps: [["push", "-u", "origin", "HEAD"]] };
    case "open_pull_request": {
      const title = str(input.title).trim();
      if (!title) return { error: "Error: a pull request needs a title." };
      return {
        program: "gh",
        steps: [
          [
            "pr",
            "create",
            "--title",
            title,
            "--body",
            str(input.body),
            ...(input.draft === true ? ["--draft"] : []),
          ],
        ],
      };
    }
    default:
      return { error: `Error: there's no tool called ${call.name}.` };
  }
}

/** What a git call would do, in words, for its approval box. */
export function gitSummary(call: ToolCall): string {
  const input = call.input;
  switch (call.name) {
    case "git_branch":
      return `Create and switch to branch ${str(input.name)}`;
    case "git_commit":
      return `Commit${input.all === true ? " everything" : " what's staged"}: “${str(input.message).split("\n")[0] ?? ""}”`;
    case "git_push":
      return "Push this branch to origin";
    case "open_pull_request":
      return `Open a${input.draft === true ? " draft" : ""} pull request: “${str(input.title)}”`;
    default:
      return call.name;
  }
}

/** CA-03: one shell command in the repository. Each one asks you first. */
export const COMMAND_TOOL: ToolSpec = {
  name: "run_command",
  description:
    "Run one shell command in the repository's root folder, e.g. the tests or a build. The " +
    "user approves each command before it runs and may decline. There's no input: commands " +
    "that ask a question fail. Output and the exit code come back; long output keeps its start " +
    "and end. The time limit is 2 minutes unless you ask for more (up to 10).",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command, exactly as it would be typed." },
      timeout_seconds: {
        type: ["integer", "null"],
        description: "Seconds before it's stopped; null for 120. At most 600.",
      },
    },
    required: ["command", "timeout_seconds"],
    additionalProperties: false,
  },
};

/** Keeps the start and the end of long output (the end is where test failures are). */
const HEAD = 8_000;

/** A command's result as the model reads it. */
export function commandOutput(
  command: string,
  r: {
    output: string;
    exitCode: number | null;
    timedOut: boolean;
    stopped: boolean;
    truncated: boolean;
    elapsedMs: number;
  },
  timeoutSecs: number,
): string {
  const out =
    r.output.length > MAX_TOOL_OUTPUT_CHARS
      ? `${r.output.slice(0, HEAD)}\n[… ${String(r.output.length - MAX_TOOL_OUTPUT_CHARS)} characters cut …]\n${r.output.slice(-(MAX_TOOL_OUTPUT_CHARS - HEAD))}`
      : r.output;
  const end = r.timedOut
    ? `[stopped: it ran past the ${String(timeoutSecs)} s time limit]`
    : r.stopped
      ? "[stopped by the user]"
      : `[exit code ${String(r.exitCode ?? "unknown")}, ${(r.elapsedMs / 1000).toFixed(1)} s]`;
  return [`$ ${command}`, out.trimEnd(), r.truncated ? "[output past 1 MB wasn't kept]" : null, end]
    .filter((x): x is string => Boolean(x))
    .join("\n");
}

/** A file change a tool made, kept so it can be shown and undone (CA-02). */
export interface FileChange {
  path: string;
  fromPath: string | null;
  before: string | null;
  after: string | null;
  /** WF-04: a binary file's bytes, kept by the run for undo; `before` and `after` read them. */
  binary?: { before: Uint8Array | null; after: Uint8Array };
}

export interface ToolOutcome {
  output: string;
  isError: boolean;
  /** The folder the call worked in, so that folder's CLAUDE.md and AGENTS.md apply (CA-06). */
  folder: string | null;
  change?: FileChange;
  /** WF-03: an image to show the model with the result. */
  images?: { mime: string; bytes: Uint8Array }[];
}

/** Anthropic takes images up to 5 MB once base64-encoded: about 3.75 MB of file. */
export const MAX_IMAGE_BYTES = 3_750_000;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** A whole text file, reading every part. */
export async function readWhole(repo: RepoApi, projectId: string, path: string): Promise<string> {
  let text = "";
  let offset = 0;
  for (;;) {
    const f = await repo.read(projectId, path, offset);
    text += f.content;
    if (!f.truncated) return text;
    offset = f.offset + new TextEncoder().encode(f.content).length;
  }
}

const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);

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
  /** WF-03: PDF text; the app's PDF.js reader unless a test gives one. */
  pdfText: (bytes: Uint8Array) => Promise<string[]> = async (b) =>
    (await import("@/files/pdfText")).readPdfText(b),
): Promise<ToolOutcome> {
  const input = call.input;
  try {
    switch (call.name) {
      case "read_document": {
        const path = str(input.path);
        const offset = typeof input.offset === "number" && input.offset > 0 ? input.offset : 0;
        const kind = docKind(path);
        if (kind === "other") {
          const f = await repo.read(projectId, path, 0);
          return { output: partOf(f.content, offset), isError: false, folder: parent(f.path) };
        }
        if (kind === "image") {
          if (!repo.readBytes) {
            return {
              output: "Error: images can't be read here.",
              isError: true,
              folder: parent(path),
            };
          }
          const bytes = await repo.readBytes(projectId, path);
          if (bytes.length > MAX_IMAGE_BYTES) {
            return {
              output: `Error: ${path} is ${(bytes.length / 1e6).toFixed(1)} MB; images over 3.75 MB can't be shown. Ask the user for a smaller copy.`,
              isError: true,
              folder: parent(path),
            };
          }
          const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
          const mime = IMAGE_MIME[ext] ?? "image/png";
          return {
            output: `${path}: an image (${mime}, ${String(Math.round(bytes.length / 1024))} KB), shown below.`,
            isError: false,
            folder: parent(path),
            images: [{ mime, bytes }],
          };
        }
        if (!repo.readBytes)
          return {
            output: "Error: documents can't be read here.",
            isError: true,
            folder: parent(path),
          };
        const bytes = await repo.readBytes(projectId, path);
        const full =
          kind === "word"
            ? docxText(bytes)
            : kind === "excel"
              ? xlsxText(
                  bytes,
                  typeof input.sheet === "string" && input.sheet ? input.sheet : null,
                  typeof input.range === "string" && input.range ? input.range : null,
                )
              : (await pdfText(bytes))
                  .map((page, i) => `${pageMarker(i + 1)}\n${page}`)
                  .join("\n\n");
        return {
          output: partOf(full || "(no text in this document)", offset),
          isError: false,
          folder: parent(path),
        };
      }
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
      case "edit_file": {
        const path = str(input.path);
        const oldText = str(input.old_text);
        const before = await readWhole(repo, projectId, path);
        const n = count(before, oldText);
        if (n !== 1) {
          return {
            output: n
              ? `Error: old_text appears ${String(n)} times in ${path}; include more lines so it's unique.`
              : `Error: old_text isn't in ${path}. Read the file and copy it exactly.`,
            isError: true,
            folder: parent(path),
          };
        }
        const after = before.replace(oldText, () => str(input.new_text));
        const done = await repo.write(projectId, path, after);
        return {
          output: `Edited ${done.path}.`,
          isError: false,
          folder: parent(done.path),
          change: { path: done.path, fromPath: null, before: done.before, after },
        };
      }
      case "write_document": {
        if (!repo.writeBytes) {
          return { output: "Error: documents can't be written here.", isError: true, folder: null };
        }
        const path = str(input.path);
        const made = await buildDocument(input);
        const now = await documentNow(repo, projectId, path);
        const written = await repo.writeBytes(projectId, path, made.bytes);
        return {
          output: `${now ? "Replaced" : "Created"} ${written} (${String(Math.round(made.bytes.length / 1024))} KB).`,
          isError: false,
          folder: parent(written),
          change: {
            path: written,
            fromPath: null,
            before: now?.text ?? null,
            after: made.text,
            binary: { before: now?.bytes ?? null, after: made.bytes },
          },
        };
      }
      case "write_file": {
        const content = str(input.content);
        const done = await repo.write(projectId, str(input.path), content);
        return {
          output: `${done.before === null ? "Created" : "Replaced"} ${done.path}.`,
          isError: false,
          folder: parent(done.path),
          change: { path: done.path, fromPath: null, before: done.before, after: content },
        };
      }
      case "delete_file": {
        const done = await repo.remove(projectId, str(input.path));
        return {
          output: `Deleted ${done.path}.`,
          isError: false,
          folder: parent(done.path),
          change: { path: done.path, fromPath: null, before: done.before, after: null },
        };
      }
      case "move_file": {
        const from = str(input.from);
        const done = await repo.move(projectId, from, str(input.to));
        return {
          output: `Moved ${from} to ${done.path}.`,
          isError: false,
          folder: parent(done.path),
          change: { path: done.path, fromPath: from, before: null, after: null },
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

/**
 * What an edit tool would change, without changing anything: for Ask mode's diff before you
 * allow it (CA-04). Same rules as running it; an edit that would fail says why here.
 */
export async function previewChange(
  repo: RepoApi,
  projectId: string,
  call: ToolCall,
): Promise<{ change: FileChange } | { error: string }> {
  const input = call.input;
  const path = str(input.path);
  const current = () => readWhole(repo, projectId, path).catch(() => null);
  try {
    switch (call.name) {
      case "edit_file": {
        const before = await readWhole(repo, projectId, path);
        const oldText = str(input.old_text);
        const n = count(before, oldText);
        if (n !== 1) {
          return {
            error: n
              ? `Error: old_text appears ${String(n)} times in ${path}; include more lines so it's unique.`
              : `Error: old_text isn't in ${path}. Read the file and copy it exactly.`,
          };
        }
        const after = before.replace(oldText, () => str(input.new_text));
        return { change: { path, fromPath: null, before, after } };
      }
      case "write_file":
        return {
          change: { path, fromPath: null, before: await current(), after: str(input.content) },
        };
      case "delete_file": {
        const before = await readWhole(repo, projectId, path);
        return { change: { path, fromPath: null, before, after: null } };
      }
      case "move_file":
        return {
          change: { path: str(input.to), fromPath: str(input.from), before: null, after: null },
        };
      case "write_document": {
        const made = await buildDocument(input);
        const now = await documentNow(repo, projectId, path);
        return {
          change: {
            path,
            fromPath: null,
            before: now?.text ?? null,
            after: made.text,
            binary: { before: now?.bytes ?? null, after: made.bytes },
          },
        };
      }
      default:
        return { error: `Error: there's no tool called ${call.name}.` };
    }
  } catch (e) {
    return { error: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
