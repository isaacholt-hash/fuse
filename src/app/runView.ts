// A coding run as it shows on its answer (M6 step 5b): each tool call as one plain line, each
// turn's note, the cost against the cap. The last turn of a finished run is the answer itself.
import { diffLines, diffStats } from "@/artifacts/diff";
import { formatUsd } from "@/cost/cost";
import type { Approval, AuditEntry, Run, RunChange, RunStep } from "@/storage/runs";
import type { AuditRowView } from "@/ui/AgentAudit";
import type { ApprovalRequest } from "@/agent/run";
import { KIND_LABEL, kindOf } from "@/agent/registry";
import type { ApprovalView, RunChangeView, RunStepView, RunView } from "@/ui/types";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function toolLabel(name: string, input: Record<string, unknown>): string {
  const path = str(input.path);
  switch (name) {
    case "edit_file":
      return `Edited ${path}`;
    case "write_file":
      return `Wrote ${path}`;
    case "delete_file":
      return `Deleted ${path}`;
    case "move_file":
      return `Moved ${str(input.from)} → ${str(input.to)}`;
    case "run_command":
      return `Ran ${str(input.command)}`;
    case "fetch_url":
      return `Read ${str(input.url)}`;
    case "run_python":
      return "Ran a Python script";
    case "git_status":
      return "Checked git status";
    case "git_diff":
      return `Looked at the diff${str(input.path) ? ` of ${str(input.path)}` : ""}`;
    case "git_log":
      return "Looked at recent commits";
    case "git_branch":
      return `Made branch ${str(input.name)}`;
    case "git_commit":
      return `Committed “${str(input.message).split("\n")[0] ?? ""}”`;
    case "git_push":
      return "Pushed the branch";
    case "open_pull_request":
      return `Opened a pull request: “${str(input.title)}”`;
    case "list_files":
      return input.recursive === true
        ? `Listed everything under ${path || "the root"}`
        : `Listed ${path || "the root"}`;
    case "read_file":
      return `Read ${path}`;
    case "search_files":
      return `Searched for “${str(input.query)}”${path ? ` in ${path}` : ""}`;
    default:
      return name;
  }
}

export function changeView(c: RunChange): RunChangeView {
  const lines = c.fromPath ? [] : diffLines(c.before ?? "", c.after ?? "");
  const { added, removed } = diffStats(lines);
  const label = c.fromPath
    ? `Moved ${c.fromPath} → ${c.path}`
    : c.before === null
      ? `Created ${c.path}`
      : c.after === null
        ? `Deleted ${c.path}`
        : `Edited ${c.path}`;
  return {
    id: c.id,
    label,
    added,
    removed,
    lines,
    undone: c.status === "undone",
    previewable: c.status !== "undone" && (c.after !== null || c.fromPath !== null),
  };
}

/**
 * WF-06: an organise plan's moves show as one row, "Organised N files", listing each move. Its
 * Undo (by the first move's id) undoes the whole plan.
 */
export function groupBatches(changes: readonly RunChange[]): RunChangeView[] {
  const out: RunChangeView[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    if (!c.batchId) {
      out.push(changeView(c));
      continue;
    }
    if (seen.has(c.batchId)) continue;
    seen.add(c.batchId);
    const batch = changes.filter((x) => x.batchId === c.batchId);
    out.push({
      id: c.id,
      label: `Organised ${String(batch.length)} file${batch.length === 1 ? "" : "s"}`,
      added: 0,
      removed: 0,
      lines: batch.map((x) => ({
        kind: "same" as const,
        text: `${x.fromPath ?? "?"} → ${x.path}`,
      })),
      undone: batch.every((x) => x.status === "undone"),
      previewable: false,
    });
  }
  return out;
}

/** What the run is asking you about, as the card shows it. */
export function approvalView(req: ApprovalRequest): ApprovalView {
  if (req.kind === "git") return { kind: "git", summary: req.summary, remote: req.remote };
  if (req.kind === "organise") return { kind: "organise", moves: req.moves, reason: req.reason };
  if (req.kind === "network") return { kind: "network", command: req.command };
  if (req.kind === "fetch") return { kind: "fetch", url: req.url, why: req.why };
  if (req.kind === "python") {
    return { kind: "python", script: req.script, keep: req.keep, network: req.network };
  }
  return req.kind === "command"
    ? {
        kind: "command",
        command: req.command,
        destructive: req.destructive ?? null,
        ...(req.unsandboxed ? { unsandboxed: true } : {}),
      }
    : {
        kind: "edit",
        change: changeView({
          ...req.change,
          id: "pending",
          runId: req.runId,
          stepId: null,
          beforeSha: null,
          afterSha: null,
          batchId: null,
          status: "applied",
          createdAt: 0,
        }),
      };
}

/** A tool result's first line that says something: not "Error: ", not a command's "$ …" echo. */
function firstLine(output: string): string | null {
  return (
    output
      .replace(/^Error: /, "")
      .split("\n")
      .find((l) => l.trim() && !l.startsWith("$ ")) ?? null
  );
}

const ALLOWED: Record<Approval, string> = {
  auto: "needed nobody",
  you: "you",
  always: "always allowed",
  denied: "declined",
};

/** One audit row (AG-04). */
export function auditRow(e: AuditEntry): AuditRowView {
  return {
    id: e.id,
    when: new Date(e.at).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    project: e.project,
    model: e.model,
    action: toolLabel(e.tool, e.input),
    kind: ((k) => (k ? KIND_LABEL[k] : ""))(kindOf(e.tool)),
    flagged: e.flags.length ? `Flagged: ${e.flags.map((f) => f.why).join("; ")}` : "",
    allowed: e.approval ? ALLOWED[e.approval] : "—",
    result: firstLine(e.output) ?? "",
    failed: e.isError,
    runCost: formatUsd(e.runCostMicroUsd),
  };
}

const MODE_LABELS: Record<Run["mode"], string> = {
  plan: "read-only",
  ask: "asks first",
  auto_edit: "can edit files",
};

export function runView(
  run: Run,
  steps: RunStep[],
  streaming = "",
  changes: RunChange[] = [],
): RunView {
  const lastModel = steps.findLast((s) => s.kind === "model");
  const views: RunStepView[] = run.plan
    ? [
        {
          id: "plan",
          kind: "note",
          label: `Plan (${run.planner ?? "planner"}):\n${run.plan}`,
          error: null,
        },
      ]
    : [];
  for (const s of steps) {
    if (run.summaryUpto !== null && s.seq === run.summaryUpto + 1) {
      views.push({
        id: `summary-${String(run.summaryUpto)}`,
        kind: "note",
        label: "Earlier steps were summarized to save space.",
        error: null,
      });
    }
    if (s.kind === "tool") {
      views.push({
        id: s.id,
        kind: "tool",
        label: toolLabel(s.call.name, s.call.input),
        error: s.isError ? firstLine(s.output) : null,
        ...(s.call.name === "run_command" || s.call.name === "run_python"
          ? { output: s.output }
          : {}),
      });
    } else if (s.text.trim() && !(run.status === "done" && s === lastModel)) {
      views.push({ id: s.id, kind: "note", label: s.text.trim(), error: null });
    }
  }
  return {
    id: run.id,
    title: run.kind === "work" ? "Work run" : "Coding run",
    status: run.status,
    costLabel: `${formatUsd(run.spentMicroUsd)} of ${formatUsd(run.capMicroUsd)}`,
    note: run.note,
    steps: views,
    streaming,
    modeLabel: MODE_LABELS[run.mode],
    branch: run.branch,
    changes: groupBatches(changes),
    inProject: run.projectId !== null,
  };
}
