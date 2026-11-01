import { ArrowLeft, CalendarClock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { describeRepeat, type Schedule } from "@/storage/schedules";
import { money } from "./format";
import { Greyed, Modal } from "./primitives";
import { TaskDialog } from "./Schedules";
import {
  draftOf,
  freshDraft,
  lastLine,
  scheduleStatus,
  when,
  type Draft,
  type ScheduleDefaults,
  type ScheduleStatus,
} from "./scheduleText";
import type { ModelOption } from "./types";

/** A task on the page, with its project's name and what its last run spent. */
export interface ScheduledRow {
  task: Schedule;
  project: string;
  lastCostMicro: number | null;
  /** Every chat it has run in that this app can open, newest first. */
  runs: { threadId: string; title: string }[];
}

const CHIP: Record<ScheduleStatus, { label: string; className: string }> = {
  active: {
    label: "Active",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  paused: { label: "Paused", className: "bg-muted text-muted-foreground" },
  done: { label: "Done", className: "bg-muted text-muted-foreground" },
  idle: { label: "Not scheduled", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
};

/**
 * M10 step 15: every project's scheduled tasks in one place, in the Code area. In the web app
 * they can be added, paused, edited and deleted here; the desktop shows HULK's read-only while
 * paired, and why not otherwise (PL-02).
 */
export function ScheduledScreen({
  rows,
  editable,
  unavailable,
  projects,
  prompts,
  models,
  defaultsFor,
  timeZone,
  now = () => Date.now(),
  onSave,
  onToggle,
  onDelete,
  onOpenChat,
  onBack,
}: {
  /** Null while loading. */
  rows: ScheduledRow[] | null;
  /** The web app: tasks can be changed here. */
  editable: boolean;
  /** Why there's nothing to show (the desktop, not paired). */
  unavailable: string | null;
  projects: { id: string; name: string }[];
  /** CH-12: saved prompts a new task can start from. */
  prompts: { id: string; name: string; body: string }[];
  models: ModelOption[];
  defaultsFor: (projectId: string) => ScheduleDefaults;
  timeZone: string;
  now?: () => number;
  onSave: (id: string | null, projectId: string, draft: Draft) => Promise<string | null>;
  onToggle: (id: string, on: boolean) => void;
  onDelete: (id: string) => void;
  onOpenChat: (threadId: string) => void;
  onBack: () => void;
}) {
  const [editing, setEditing] = useState<{
    id: string | null;
    projectId: string;
    draft: Draft;
  } | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [newProject, setNewProject] = useState<string>(projects[0]?.id ?? "");
  const [fromPrompt, setFromPrompt] = useState<string>("");
  const [shownRuns, setShownRuns] = useState<string | null>(null);
  const project = newProject || projects[0]?.id || "";
  const startNew = () => {
    if (!project) return;
    const base = freshDraft(defaultsFor(project), now());
    const prompt = prompts.find((p) => p.id === fromPrompt);
    setEditing({
      id: null,
      projectId: project,
      draft: prompt ? { ...base, name: prompt.name, prompt: prompt.body } : base,
    });
  };
  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <header className="flex h-[66px] items-center border-b px-6">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          Back to sessions
        </Button>
      </header>
      <div className="mx-auto max-w-[760px] px-4 py-9 sm:px-8">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CalendarClock className="size-5" />
          Scheduled tasks
        </h1>
        <p className="mt-2 text-xs text-muted-foreground">
          Saved prompts HULK runs by itself, once or every day or week, each in a new session. Times
          are HULK&apos;s local time ({timeZone}).
        </p>
        {unavailable && (
          <div className="mt-6">
            <Greyed>{unavailable}</Greyed>
          </div>
        )}
        {!editable && !unavailable && rows !== null && (
          <p className="mt-4 text-[11px] text-muted-foreground">
            These are HULK&apos;s. Add or change them in the web app on HULK.
          </p>
        )}
        {editable && (
          <div className="mt-6 flex flex-wrap items-center gap-2 text-xs">
            {projects.length === 0 ? (
              <span className="text-muted-foreground">
                Make a project first: a task runs in one.
              </span>
            ) : (
              <>
                <label className="flex items-center gap-2">
                  In
                  <select
                    aria-label="Project for the new task"
                    className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                    value={project}
                    onChange={(e) => {
                      setNewProject(e.target.value);
                    }}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                {prompts.length > 0 && (
                  <label className="flex items-center gap-2">
                    from
                    <select
                      aria-label="Start from a saved prompt"
                      className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                      value={fromPrompt}
                      onChange={(e) => {
                        setFromPrompt(e.target.value);
                      }}
                    >
                      <option value="">A blank prompt</option>
                      {prompts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <Button size="sm" variant="outline" onClick={startNew}>
                  New task
                </Button>
              </>
            )}
          </div>
        )}
        {rows === null && !unavailable ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading tasks…</p>
        ) : rows !== null && rows.length === 0 && !unavailable ? (
          <p className="mt-8 text-sm text-muted-foreground">No scheduled tasks yet.</p>
        ) : (
          rows &&
          rows.length > 0 && (
            <ul className="mt-6 divide-y rounded-lg border" aria-label="Every scheduled task">
              {rows.map(({ task: s, project: projectName, lastCostMicro, runs }) => {
                const status = scheduleStatus(s);
                const last = lastLine(s);
                return (
                  <li key={s.id} className="px-4 py-3 text-xs">
                    <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{s.name}</span>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${CHIP[status].className}`}
                          >
                            {CHIP[status].label}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {projectName} · {describeRepeat(s)} · on HULK
                          {s.enabled && s.nextAt !== null && <> · next {when(s.nextAt)}</>}
                        </span>
                        {last && (
                          <span
                            className={`mt-0.5 block text-[11px] ${last.failed ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {last.text}
                            {lastCostMicro !== null && <> · {money(lastCostMicro)}</>}
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {s.lastThreadId && runs.some((r) => r.threadId === s.lastThreadId) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[11px]"
                            aria-label={`Open the last session of ${s.name}`}
                            onClick={() => {
                              if (s.lastThreadId) onOpenChat(s.lastThreadId);
                            }}
                          >
                            Open
                          </Button>
                        )}
                        {runs.length > 1 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[11px]"
                            aria-expanded={shownRuns === s.id}
                            onClick={() => {
                              setShownRuns(shownRuns === s.id ? null : s.id);
                            }}
                          >
                            All {runs.length} runs
                          </Button>
                        )}
                        {editable && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-[11px]"
                              aria-label={`${s.enabled ? "Pause" : "Resume"} ${s.name}`}
                              onClick={() => {
                                onToggle(s.id, !s.enabled);
                              }}
                            >
                              {s.enabled ? "Pause" : "Resume"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-[11px]"
                              aria-label={`Edit ${s.name}`}
                              onClick={() => {
                                setEditing({ id: s.id, projectId: s.projectId, draft: draftOf(s) });
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-[11px] text-destructive"
                              aria-label={`Delete ${s.name}`}
                              onClick={() => {
                                setDeleting(s);
                              }}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </span>
                    </div>
                    {shownRuns === s.id && (
                      <ul className="mt-2 space-y-1 border-l pl-3" aria-label={`Runs of ${s.name}`}>
                        {runs.map((r) => (
                          <li key={r.threadId}>
                            <button
                              type="button"
                              className="text-[11px] underline underline-offset-2 hover:text-foreground"
                              onClick={() => {
                                onOpenChat(r.threadId);
                              }}
                            >
                              {r.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>
      {editing && (
        <TaskDialog
          key={editing.id ?? "new"}
          editing={{ id: editing.id, draft: editing.draft }}
          models={models}
          onClose={() => {
            setEditing(null);
          }}
          onSave={(id, draft) => onSave(id, editing.projectId, draft)}
        />
      )}
      <Modal
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? "this task"}?`}
        description="It won't run again. The sessions it ran in are kept."
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setDeleting(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const s = deleting;
              setDeleting(null);
              if (s) onDelete(s.id);
            }}
          >
            Delete task
          </Button>
        </div>
      </Modal>
    </main>
  );
}
