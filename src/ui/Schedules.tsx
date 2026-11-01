import { CalendarClock } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RunKind, RunMode } from "@/storage/runs";
import {
  describeRepeat,
  type Repeat,
  type Schedule,
  type ScheduleInput,
} from "@/storage/schedules";
import { Greyed, Modal } from "./primitives";
import type { ModelOption } from "./types";

/** What a new task starts with: the project's kind, mode and model, and the usual cost cap. */
export interface ScheduleDefaults {
  kind: RunKind;
  mode: RunMode;
  model: { provider: string; id: string };
  capMicroUsd: number;
}

type Draft = Omit<ScheduleInput, "projectId">;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MODES: { value: RunMode; label: string }[] = [
  { value: "plan", label: "Read-only" },
  { value: "ask", label: "Ask first" },
  { value: "auto_edit", label: "Can edit files" },
];
const field =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm disabled:opacity-50";

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const toMinute = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const day = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function lastLine(s: Schedule): { text: string; failed: boolean } | null {
  if (s.lastAt === null) return null;
  const at = when(s.lastAt);
  switch (s.lastStatus) {
    case null:
      return { text: `Started ${at}`, failed: false };
    case "done":
      return { text: `Last run ${at}: done`, failed: false };
    case "error":
      return { text: `Last run ${at} failed: ${s.lastNote ?? "no reason given"}`, failed: true };
    default:
      return {
        text: `Last run ${at}: ${s.lastStatus}${s.lastNote ? ` (${s.lastNote})` : ""}`,
        failed: false,
      };
  }
}

/**
 * Project settings → Scheduled tasks (M10 step 9, AG-07): saved prompts the runner on HULK
 * starts at a time, once or every day or week, each in a new chat. Web app only: on the desktop
 * it's greyed until sync (PL-04).
 */
export function ScheduledTasksSection({
  web,
  tasks,
  models,
  defaults,
  timeZone,
  now = () => Date.now(),
  onSave,
  onToggle,
  onDelete,
  onOpenChat,
}: {
  web: boolean;
  tasks: Schedule[];
  models: ModelOption[];
  defaults: ScheduleDefaults;
  /** The browser's time zone name, shown with the times (taken as HULK's for now). */
  timeZone: string;
  now?: () => number;
  /** Saves a new task (id null) or an edit; resolves to a problem to show, or null. */
  onSave: (id: string | null, draft: Draft) => Promise<string | null>;
  onToggle: (id: string, on: boolean) => void;
  onDelete: (id: string) => void;
  onOpenChat: (threadId: string) => void;
}) {
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const fresh = (): Draft => {
    const at = new Date(now() + 3_600_000);
    at.setMinutes(0, 0, 0);
    return {
      name: "",
      prompt: "",
      kind: defaults.kind,
      mode: defaults.mode,
      provider: defaults.model.provider,
      model: defaults.model.id,
      capMicroUsd: defaults.capMicroUsd,
      repeat: "daily",
      onceAt: at.getTime(),
      minute: 9 * 60,
      weekday: 1,
    };
  };
  return (
    <section aria-label="Scheduled tasks">
      <div className="mb-1 flex items-center gap-2">
        <CalendarClock className="size-4 text-muted-foreground" />
        <h3 className="text-xs font-medium">Scheduled tasks</h3>
      </div>
      <p className="mb-2 text-[11px] leading-5 text-muted-foreground">
        A saved prompt that runs by itself, once or every day or week, as a Code or Work run in a
        new chat in this project. Times are HULK&apos;s local time ({timeZone}).
      </p>
      {web && tasks.length === 0 && (
        <p className="mb-2 text-[11px] text-muted-foreground">No scheduled tasks yet.</p>
      )}
      {web && tasks.length > 0 && (
        <ul className="mb-2 divide-y rounded-md border text-xs" aria-label="Scheduled tasks list">
          {tasks.map((s) => {
            const last = lastLine(s);
            return (
              <li key={s.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {describeRepeat(s)} ·{" "}
                    {s.enabled
                      ? s.nextAt === null
                        ? "not again"
                        : `next ${when(s.nextAt)}`
                      : "off"}
                  </span>
                  {last && (
                    <span
                      className={`block text-[11px] ${last.failed ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {last.text}
                      {s.lastThreadId && (
                        <>
                          {" · "}
                          <button
                            type="button"
                            className="underline underline-offset-2 hover:text-foreground"
                            onClick={() => {
                              if (s.lastThreadId) onOpenChat(s.lastThreadId);
                            }}
                          >
                            Open its chat
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </span>
                <label className="flex items-center gap-1.5 text-[11px]">
                  <input
                    type="checkbox"
                    aria-label={`${s.name} on`}
                    checked={s.enabled}
                    onChange={(e) => {
                      onToggle(s.id, e.target.checked);
                    }}
                  />
                  On
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px]"
                  aria-label={`Edit ${s.name}`}
                  onClick={() => {
                    setEditing({
                      id: s.id,
                      draft: {
                        name: s.name,
                        prompt: s.prompt,
                        kind: s.kind,
                        mode: s.mode,
                        provider: s.provider,
                        model: s.model,
                        capMicroUsd: s.capMicroUsd,
                        repeat: s.repeat,
                        onceAt: s.onceAt,
                        minute: s.minute,
                        weekday: s.weekday,
                      },
                    });
                  }}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px] text-destructive"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => {
                    setDeleting(s);
                  }}
                >
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!web}
        onClick={() => {
          setEditing({ id: null, draft: fresh() });
        }}
      >
        Add a task
      </Button>
      {!web && <Greyed>Scheduled tasks run in the web app on HULK (until sync).</Greyed>}
      {editing && (
        <TaskDialog
          key={editing.id ?? "new"}
          editing={editing}
          models={models}
          onClose={() => {
            setEditing(null);
          }}
          onSave={onSave}
        />
      )}
      <Modal
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? "this task"}?`}
        description="It won't run again. The chats it ran in are kept."
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
    </section>
  );
}

function TaskDialog({
  editing,
  models,
  onClose,
  onSave,
}: {
  editing: { id: string | null; draft: Draft };
  models: ModelOption[];
  onClose: () => void;
  onSave: (id: string | null, draft: Draft) => Promise<string | null>;
}) {
  const [d, setD] = useState<Draft>(editing.draft);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const ids = {
    name: `${id}-name`,
    prompt: `${id}-prompt`,
    kind: `${id}-kind`,
    mode: `${id}-mode`,
    model: `${id}-model`,
    cap: `${id}-cap`,
    repeat: `${id}-repeat`,
    time: `${id}-time`,
    day: `${id}-day`,
    date: `${id}-date`,
  };
  const set = (patch: Partial<Draft>) => {
    setD((x) => ({ ...x, ...patch }));
    setProblem(null);
  };
  const onceDate = d.onceAt === null ? "" : day(d.onceAt);
  const onceTime =
    d.onceAt === null
      ? "09:00"
      : hhmm(new Date(d.onceAt).getHours() * 60 + new Date(d.onceAt).getMinutes());
  const setOnce = (date: string, time: string) => {
    const at = date ? new Date(`${date}T${time || "00:00"}`).getTime() : NaN;
    set({ onceAt: Number.isNaN(at) ? null : at });
  };
  const label = "mb-1 block text-xs font-medium";
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={editing.id ? "Edit scheduled task" : "Add a scheduled task"}
      description="It runs on HULK, by itself, in a new chat in this project."
      wide
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          onSave(editing.id, d).then(
            (said) => {
              setBusy(false);
              if (said) setProblem(said);
              else onClose();
            },
            (err: unknown) => {
              setBusy(false);
              setProblem(err instanceof Error ? err.message : String(err));
            },
          );
        }}
      >
        <div className="sm:col-span-2">
          <label htmlFor={ids.name} className={label}>
            Name
          </label>
          <Input
            id={ids.name}
            autoFocus
            maxLength={80}
            placeholder="e.g. Morning dependency check"
            value={d.name}
            onChange={(e) => {
              set({ name: e.target.value });
            }}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={ids.prompt} className={label}>
            Prompt
          </label>
          <textarea
            id={ids.prompt}
            className="block min-h-20 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
            placeholder="e.g. Update the dependencies, run the tests, and summarise what changed."
            value={d.prompt}
            onChange={(e) => {
              set({ prompt: e.target.value });
            }}
          />
        </div>
        <div>
          <label htmlFor={ids.kind} className={label}>
            Run
          </label>
          <select
            id={ids.kind}
            className={field}
            value={d.kind}
            onChange={(e) => {
              set({ kind: e.target.value === "work" ? "work" : "code" });
            }}
          >
            <option value="code">Code</option>
            <option value="work">Work</option>
          </select>
        </div>
        <div>
          <label htmlFor={ids.mode} className={label}>
            What it may do
          </label>
          <select
            id={ids.mode}
            className={field}
            value={d.mode}
            onChange={(e) => {
              set({ mode: MODES.find((m) => m.value === e.target.value)?.value ?? "ask" });
            }}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={ids.model} className={label}>
            Model
          </label>
          <select
            id={ids.model}
            className={field}
            value={`${d.provider}/${d.model}`}
            onChange={(e) => {
              const m = models.find((x) => `${x.provider}/${x.id}` === e.target.value);
              if (m) set({ provider: m.provider, model: m.id });
            }}
          >
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.providerName} · {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={ids.cap} className={label}>
            Cost cap (US$ per run)
          </label>
          <Input
            id={ids.cap}
            type="number"
            min={0.01}
            step={0.01}
            value={(d.capMicroUsd / 1_000_000).toFixed(2)}
            onChange={(e) => {
              const usd = Number(e.target.value);
              if (Number.isFinite(usd) && usd > 0)
                set({ capMicroUsd: Math.round(usd * 1_000_000) });
            }}
          />
        </div>
        <div>
          <label htmlFor={ids.repeat} className={label}>
            Repeat
          </label>
          <select
            id={ids.repeat}
            className={field}
            value={d.repeat}
            onChange={(e) => {
              const r: Repeat =
                e.target.value === "once"
                  ? "once"
                  : e.target.value === "weekly"
                    ? "weekly"
                    : "daily";
              set({ repeat: r, weekday: d.weekday ?? 1 });
            }}
          >
            <option value="once">Once</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
          </select>
        </div>
        {d.repeat === "once" ? (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={ids.date} className={label}>
                Date
              </label>
              <Input
                id={ids.date}
                type="date"
                value={onceDate}
                onChange={(e) => {
                  setOnce(e.target.value, onceTime);
                }}
              />
            </div>
            <div>
              <label htmlFor={ids.time} className={label}>
                Time
              </label>
              <Input
                id={ids.time}
                type="time"
                value={onceTime}
                onChange={(e) => {
                  setOnce(onceDate, e.target.value);
                }}
              />
            </div>
          </div>
        ) : (
          <div className={d.repeat === "weekly" ? "grid grid-cols-2 gap-2" : ""}>
            {d.repeat === "weekly" && (
              <div>
                <label htmlFor={ids.day} className={label}>
                  Day
                </label>
                <select
                  id={ids.day}
                  className={field}
                  value={d.weekday ?? 1}
                  onChange={(e) => {
                    set({ weekday: Number(e.target.value) });
                  }}
                >
                  {DAYS.map((name, i) => (
                    <option key={name} value={i}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor={ids.time} className={label}>
                Time
              </label>
              <Input
                id={ids.time}
                type="time"
                value={hhmm(d.minute)}
                onChange={(e) => {
                  if (e.target.value) set({ minute: toMinute(e.target.value) });
                }}
              />
            </div>
          </div>
        )}
        {problem && (
          <p role="alert" className="text-xs text-destructive sm:col-span-2">
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {editing.id ? "Save task" : "Add task"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
