// A coding run as it shows on its answer (M6 step 5b): each tool call as one plain line, each
// turn's note, the cost against the cap. The last turn of a finished run is the answer itself.
import { formatUsd } from "@/cost/cost";
import type { Run, RunStep } from "@/storage/runs";
import type { RunStepView, RunView } from "@/ui/types";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function toolLabel(name: string, input: Record<string, unknown>): string {
  const path = str(input.path);
  switch (name) {
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

export function runView(run: Run, steps: RunStep[], streaming = ""): RunView {
  const lastModel = steps.findLast((s) => s.kind === "model");
  const views: RunStepView[] = [];
  for (const s of steps) {
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
    status: run.status,
    costLabel: `${formatUsd(run.spentMicroUsd)} of ${formatUsd(run.capMicroUsd)}`,
    note: run.note,
    steps: views,
    streaming,
  };
}
