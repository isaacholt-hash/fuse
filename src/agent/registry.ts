// Every tool FUSE can offer a model, in one list (M9 step 1, AG-01). Each has a kind, which is
// what approvals, read-only runs and the activity log go by, and the places it can run. The order
// is the order a run's tools are sent in, fixed so the prompt cache holds.
import type { ToolSpec } from "@/providers/types";
import {
  COMMAND_TOOL,
  EDIT_TOOLS,
  FETCH_URL_TOOL,
  GIT_READ_TOOLS,
  GIT_WRITE_TOOLS,
  ORGANISE_TOOL,
  READ_DOCUMENT_TOOL,
  READ_ONLY_TOOLS,
  WRITE_DOCUMENT_TOOL,
} from "./tools";

/**
 * What a tool does, from least to most care: reading runs freely; writing changes files (or a
 * local git repository); a command runs a program; sending reaches someone else (a push, a pull
 * request); spending costs money beyond the model call.
 */
export type ToolKind = "read" | "write" | "command" | "send" | "spend";

/** Where a tool can be offered: a Code or Work run, or a plain chat (read-only tools, step 2). */
export type ToolPlace = "code" | "work" | "chat";

export interface ToolEntry {
  spec: ToolSpec;
  kind: ToolKind;
  places: readonly ToolPlace[];
  /** Kept on in every project: a run can't find its way around its folders without it. */
  core?: boolean;
}

const entry = (
  spec: ToolSpec,
  kind: ToolKind,
  places: readonly ToolPlace[],
  core = false,
): ToolEntry => ({ spec, kind, places, ...(core ? { core } : {}) });

const BOTH = ["code", "work"] as const;

export const TOOLS: readonly ToolEntry[] = [
  ...READ_ONLY_TOOLS.map((t) => entry(t, "read", BOTH, true)),
  ...GIT_READ_TOOLS.map((t) => entry(t, "read", ["code"])),
  entry(READ_DOCUMENT_TOOL, "read", ["work"]),
  entry(FETCH_URL_TOOL, "read", ["code", "work", "chat"]),
  ...EDIT_TOOLS.map((t) => entry(t, "write", BOTH)),
  entry(WRITE_DOCUMENT_TOOL, "write", ["work"]),
  entry(ORGANISE_TOOL, "write", ["work"]),
  entry(COMMAND_TOOL, "command", BOTH),
  ...GIT_WRITE_TOOLS.map((t) =>
    entry(t, t.name === "git_push" || t.name === "open_pull_request" ? "send" : "write", ["code"]),
  ),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.spec.name, t]));

/** The tool's entry, or undefined for a name FUSE doesn't have. */
export const toolEntry = (name: string): ToolEntry | undefined => BY_NAME.get(name);

/** The tool's kind, or undefined for a name FUSE doesn't have. */
export const kindOf = (name: string): ToolKind | undefined => BY_NAME.get(name)?.kind;

/**
 * The tools offered in a place: in a read-only (plan) run only the read ones, and never one the
 * project switched off. Core tools can't be switched off.
 */
export function toolsIn(
  place: ToolPlace,
  {
    readOnly = false,
    off = new Set<string>(),
  }: { readOnly?: boolean; off?: ReadonlySet<string> } = {},
): ToolSpec[] {
  return TOOLS.filter(
    (t) =>
      t.places.includes(place) &&
      (!readOnly || t.kind === "read") &&
      (t.core === true || !off.has(t.spec.name)),
  ).map((t) => t.spec);
}

const PLACE_LABEL: Record<ToolPlace, string> = { code: "Code", work: "Work", chat: "Chat" };

/** "Code and Work", "Code, Work and Chat": where a tool runs, for settings. */
export function placesLabel(places: readonly ToolPlace[]): string {
  const names = places.map((p) => PLACE_LABEL[p]);
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`
    : names.join("");
}

/** "Reads", "Writes", …: how a kind reads in settings and the activity log. */
export const KIND_LABEL: Record<ToolKind, string> = {
  read: "Reads",
  write: "Writes",
  command: "Runs commands",
  send: "Sends",
  spend: "Spends",
};
