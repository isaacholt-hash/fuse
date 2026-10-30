// A coding run as it shows on its answer (M6 step 5b): each tool call as one plain line, each
// turn's note, the cost against the cap. The last turn of a finished run is the answer itself.
import { diffLines, diffStats } from "@/artifacts/diff";
import { formatUsd } from "@/cost/cost";
import type { Approval, AuditEntry, Run, RunChange, RunStep } from "@/storage/runs";
import type { AuditRowView } from "@/ui/AgentAudit";
import type { ApprovalRequest } from "@/agent/run";
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
  return { id: c.id, label, added, removed, lines, undone: c.status === "undone" };
}

/** What the run is asking you about, as the card shows it. */
export function approvalView(req: ApprovalRequest): ApprovalView {
  if (req.kind === "git") return { kind: "git", summary: req.summary, remote: req.remote };
  return req.kind === "command"
    ? { kind: "command", command: req.command, destructive: req.destructive ?? null }
    : {
        kind: "edit",
        change: changeView({
          ...req.change,
          id: "pending",
          runId: req.runId,
          stepId: null,
          beforeSha: null,
          afterSha: null,
          status: "applied",
          createdAt: 0,
        }),
      };
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
    allowed: e.approval ? ALLOWED[e.approval] : "—",
    result: e.output.split("\n").find((l) => l.trim() && !l.startsWith("$ ")) ?? "",
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
        error: s.isError ? (s.output.replace(/^Error: /, "").split("\n")[0] ?? null) : null,
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
    changes: changes.map(changeView),
  };
}
