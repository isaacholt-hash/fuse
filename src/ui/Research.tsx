import { parseResearchCap } from "@/research/cap";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "./primitives";
import { money } from "./format";
import { EMPTY_SELECTION, type ResearchSelection } from "@/research/types";
import type { ResearchModels } from "@/research/routing";
import type { ResearchTaskView } from "@/research/status";

export interface ResearchContextOption {
  id: string;
  label: string;
  kind: "memoryIds" | "artifactIds" | "messageIds";
  reason?: string;
}
export interface ResearchSetupChoice {
  task: string;
  location: "desktop" | "hulk";
  capMicroUsd: number;
  selection: ResearchSelection;
}
const field =
  "w-full rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";
export function ResearchSetup({
  initialScope,
  remoteCreatesChat = false,
  locations,
  initialLocation,
  context,
  preview,
  busy,
  error,
  onCancel,
  onStart,
}: {
  initialScope: string;
  remoteCreatesChat?: boolean;
  locations: Record<"desktop" | "hulk", string | null>;
  initialLocation: "desktop" | "hulk";
  context: ResearchContextOption[];
  preview: (scope: string, location: "desktop" | "hulk") => ResearchModels;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onStart: (choice: ResearchSetupChoice) => void;
}) {
  const [task, setTask] = useState(initialScope),
    [location, setLocation] = useState(initialLocation),
    [cap, setCap] = useState("");
  const [selection, setSelection] = useState<ResearchSelection>(structuredClone(EMPTY_SELECTION));
  let models: ResearchModels | null = null,
    reason = locations[location];
  if (!reason) {
    try {
      models = preview(task, location);
    } catch (error) {
      reason = error instanceof Error ? error.message : "Research setup is unavailable.";
    }
  }
  const amount = parseResearchCap(cap),
    valid = task.trim().length > 0 && amount !== null && models !== null && !reason && !busy;
  return (
    <Modal
      open
      wide
      title="Research"
      description="Review the scope, selected context and spending cap before starting."
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onStart({ task: task.trim(), location, capMicroUsd: amount, selection });
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          Scope
          <textarea
            autoFocus
            aria-label="Research scope"
            className={`${field} min-h-24 resize-y`}
            maxLength={64000}
            value={task}
            onChange={(event) => {
              setTask(event.target.value);
            }}
            disabled={busy}
          />
        </label>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium">Execution location</legend>
          {(["hulk", "desktop"] as const).map((place) => (
            <label key={place} className="flex items-start gap-2 text-xs">
              <input
                type="radio"
                name="research-location"
                value={place}
                checked={location === place}
                disabled={busy || locations[place] !== null}
                onChange={() => {
                  setLocation(place);
                }}
              />
              <span>
                {place === "hulk" ? "HULK" : "This computer"}
                <span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">
                  {locations[place] ??
                    (place === "hulk"
                      ? `${remoteCreatesChat ? "Starts a separate Research Chat on HULK in the same project. " : ""}Continues with this window closed. HULK can read the scope and selected context; folders and permissions stay here.`
                      : "Stops when desktop execution ends. Continue explicitly after an interruption.")}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium">
            Context — nothing selected by default
          </legend>
          <p className="text-[11px] text-muted-foreground">
            Research has no command, repository-write or additional MCP access. Your current draft
            is kept.
          </p>
          {context.length > 0 && (
            <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-md border p-2">
              {context.map((item) => (
                <label key={`${item.kind}:${item.id}`} className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    aria-label={item.label}
                    disabled={busy || Boolean(item.reason)}
                    checked={selection[item.kind].includes(item.id)}
                    onChange={(event) => {
                      setSelection((previous) => ({
                        ...previous,
                        [item.kind]: event.target.checked
                          ? [...previous[item.kind], item.id]
                          : previous[item.kind].filter((id) => id !== item.id),
                      }));
                    }}
                  />
                  <span className="min-w-0 break-words">
                    {item.label}
                    {item.reason && (
                      <span className="block text-muted-foreground">{item.reason}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-3 text-xs">
            {(["global", "project", "thread"] as const).map((level) => (
              <label key={level} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={selection.instructions.includes(level)}
                  disabled={busy}
                  onChange={(event) => {
                    setSelection((previous) => ({
                      ...previous,
                      instructions: event.target.checked
                        ? [...previous.instructions, level]
                        : previous.instructions.filter((value) => value !== level),
                    }));
                  }}
                />
                {level === "global"
                  ? "Global instructions"
                  : level === "project"
                    ? "Project instructions"
                    : "Chat instructions"}
              </label>
            ))}
          </div>
        </fieldset>
        {models && (
          <div className="space-y-1 rounded-md border p-3 text-xs">
            <p>
              {models.pinned ? "Explicit model choice" : "Auto routing"}:{" "}
              {models.worker.displayName} for research; {models.best.displayName} for planning and
              synthesis.
            </p>
            <p className="text-[11px] text-muted-foreground">{models.reason}.</p>
            <p className="text-[11px] text-muted-foreground">
              Estimate: about {money(models.estimatedMicroUsd)} for five searches and a report;
              actual usage can vary.
            </p>
            <p className="text-[11px] leading-5 text-muted-foreground">
              Planning reserves up to {money(models.firstBoundMicroUsd)}; each search reserves up to{" "}
              {money(models.searchBoundMicroUsd)}. These conservative allowances are not the final
              bill. Actual tokens and searches are charged once.
            </p>
          </div>
        )}
        <label className="flex flex-col gap-1 text-xs">
          Spending cap (USD)
          <Input
            aria-label="Research spending cap (USD)"
            inputMode="decimal"
            autoComplete="off"
            placeholder="Enter a cap"
            value={cap}
            onChange={(event) => {
              setCap(event.target.value);
            }}
            disabled={busy}
          />
        </label>
        <p className="text-[11px] leading-5 text-muted-foreground">
          At most 12 searches, 24 source reads, 30 model calls and 30 minutes. Research pauses
          before the next request cannot fit the cap or a budget; limits retain a labelled partial
          report.
        </p>
        {(reason || error) && (
          <p role="alert" className="text-xs text-destructive">
            {error ?? reason}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid}>
            {busy ? "Starting…" : "Start research"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
const stages = {
  plan: "Planning",
  search: "Searching",
  read: "Reading sources",
  synthesis: "Writing the report",
  verify: "Checking citations",
  publish: "Publishing",
  finished: "Finished",
};
export function ResearchTask({
  task,
  onPause,
  onStop,
  onContinue,
  onOpen,
}: {
  task: ResearchTaskView;
  onPause?: () => void;
  onStop?: () => void;
  onContinue?: () => void;
  onOpen?: () => void;
}) {
  const active = task.status === "running" || task.status === "queued";
  return (
    <section
      aria-label="Research progress"
      className="mx-5 my-2 space-y-2 rounded-md border px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong>Research</strong>
        <span className="text-muted-foreground">
          {task.location === "hulk" ? "HULK" : "This computer"} ·{" "}
          {task.status === "queued"
            ? "Queued"
            : task.statusUnknown
              ? "Status unavailable"
              : task.stage === "finished" && task.status !== "done"
                ? "Partial result"
                : task.stage
                  ? stages[task.stage]
                  : task.status}
        </span>
        <span className="ml-auto font-mono text-[11px]">
          {task.statusUnknown
            ? "Cost status unavailable"
            : `${money(task.spentMicroUsd)} of ${money(task.capMicroUsd)}`}
        </span>
      </div>
      <p className="line-clamp-2 text-[11px] text-muted-foreground">{task.title.slice(0, 500)}</p>
      {task.readOnly ? (
        <p className="text-muted-foreground">Synced history · read-only</p>
      ) : (
        <>
          {task.searches !== null && (
            <p className="text-muted-foreground">
              {task.searches}/12 searches · {task.reads}/24 sources · {task.modelCalls}/30 model
              calls
            </p>
          )}
          {task.heldMicroUsd > 0 && (
            <p className="text-muted-foreground">
              Pending cost allowance: {money(task.heldMicroUsd)}
            </p>
          )}
          {task.unknownMicroUsd > 0 && (
            <p role="status">
              Billing unresolved: {money(task.unknownMicroUsd)} remains held. Interrupted paid work
              is not replayed automatically.
            </p>
          )}
        </>
      )}
      {task.note && <p className="leading-5">{task.note}</p>}
      <div className="flex flex-wrap gap-2">
        {!task.readOnly && active && (
          <>
            {task.status === "running" && onPause && (
              <Button size="sm" variant="outline" disabled={task.pauseRequested} onClick={onPause}>
                {task.pauseRequested ? "Pausing…" : "Pause research"}
              </Button>
            )}
            {onStop && (
              <Button size="sm" variant="outline" onClick={onStop}>
                Stop research
              </Button>
            )}
          </>
        )}
        {!task.readOnly &&
          !active &&
          !task.statusUnknown &&
          task.stage !== null &&
          task.status !== "done" &&
          task.stage !== "finished" &&
          onContinue && (
            <Button size="sm" variant="outline" onClick={onContinue}>
              Continue research
            </Button>
          )}
        {onOpen && (
          <Button size="sm" variant="ghost" onClick={onOpen}>
            Open on HULK
          </Button>
        )}
      </div>
    </section>
  );
}
export function ContinueResearch({
  capMicroUsd,
  error,
  busy,
  onCancel,
  onContinue,
}: {
  capMicroUsd: number;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onContinue: (capMicroUsd: number) => void;
}) {
  const [value, setValue] = useState(String(capMicroUsd / 1e6)),
    amount = parseResearchCap(value);
  return (
    <Modal
      open
      title="Continue research"
      description="Continue explicitly on the execution owner. Completed work and outstanding cost exposure are retained."
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (amount !== null && amount >= capMicroUsd && !busy) onContinue(amount);
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          Total spending cap (USD)
          <Input
            aria-label="Continue research total cap (USD)"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
            inputMode="decimal"
            disabled={busy}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          This is the total cap, including previous spend. Work/time limits do not reset, and
          ambiguous requests are not retried.
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || amount === null || amount < capMicroUsd}>
            Continue research
          </Button>
        </div>
      </form>
    </Modal>
  );
}
