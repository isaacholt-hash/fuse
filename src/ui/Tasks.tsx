import { ListTodo, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type TaskStatusView = "open" | "doing" | "done" | "dropped";

const STATUS_LABELS: Record<TaskStatusView, string> = {
  open: "To do",
  doing: "In progress",
  done: "Done",
  dropped: "Dropped",
};

/** One of a project's tasks (PM-16). */
export interface TaskView {
  id: string;
  text: string;
  status: TaskStatusView;
  /** Ids of the tasks it waits on. */
  dependsOn: string[];
  /** Text of the tasks it still waits on (not done or dropped). */
  blockedBy: string[];
}

export interface TasksProps {
  tasks: TaskView[];
  onAdd: (text: string) => void;
  onStatus: (id: string, status: TaskStatusView) => void;
  onEdit: (id: string, text: string, dependsOn: string[]) => void;
  onDelete: (id: string) => void;
}

const selectClass = "h-7 rounded-md border border-input bg-background px-1.5 text-[11px]";

function TaskEditor({
  task,
  others,
  onCancel,
  onSave,
}: {
  task: TaskView;
  others: TaskView[];
  onCancel: () => void;
  onSave: (text: string, dependsOn: string[]) => void;
}) {
  const [text, setText] = useState(task.text);
  const [deps, setDeps] = useState<string[]>(task.dependsOn);
  return (
    <div className="space-y-2 rounded-lg border p-2" role="group" aria-label="Edit task">
      <Input
        aria-label="Task text"
        className="h-8 text-xs"
        maxLength={500}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      {others.length > 0 && (
        <fieldset className="text-[11px]">
          <legend className="mb-1 text-muted-foreground">Waits on</legend>
          {others.map((o) => (
            <label key={o.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={deps.includes(o.id)}
                onChange={(e) => {
                  setDeps((d) => (e.target.checked ? [...d, o.id] : d.filter((x) => x !== o.id)));
                }}
              />
              {o.text}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!text.trim()}
          onClick={() => {
            onSave(text, deps);
          }}
        >
          Save task
        </Button>
      </div>
    </div>
  );
}

/**
 * Project settings → Tasks (PM-16): the project's open work, with progress and what each task
 * waits on. Models in the project's chats see the open ones.
 */
export function TasksSection({ tasks, onAdd, onStatus, onEdit, onDelete }: TasksProps) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const current = tasks.filter((t) => t.status === "open" || t.status === "doing");
  const finished = tasks.filter((t) => t.status === "done" || t.status === "dropped");
  const add = () => {
    if (!text.trim()) return;
    onAdd(text);
    setText("");
  };
  const row = (t: TaskView) =>
    editing === t.id ? (
      <li key={t.id}>
        <TaskEditor
          task={t}
          others={tasks.filter((o) => o.id !== t.id)}
          onCancel={() => {
            setEditing(null);
          }}
          onSave={(newText, deps) => {
            onEdit(t.id, newText, deps);
            setEditing(null);
          }}
        />
      </li>
    ) : (
      <li
        key={t.id}
        className="group flex items-start gap-2 rounded-lg px-2 py-1 hover:bg-muted/50"
      >
        <select
          aria-label={`Status of ${t.text}`}
          className={selectClass}
          value={t.status}
          onChange={(e) => {
            onStatus(t.id, e.target.value as TaskStatusView);
          }}
        >
          {(Object.keys(STATUS_LABELS) as TaskStatusView[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <div className="min-w-0 flex-1 text-xs leading-7">
          <span className={t.status === "done" || t.status === "dropped" ? "line-through" : ""}>
            {t.text}
          </span>
          {t.blockedBy.length > 0 && (
            <span className="ml-2 text-[10px] text-amber-700 dark:text-amber-400">
              Blocked by {t.blockedBy.join(", ")}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Edit task: ${t.text}`}
            onClick={() => {
              setEditing(t.id);
            }}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Delete task: ${t.text}`}
            onClick={() => {
              onDelete(t.id);
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </li>
    );
  return (
    <section aria-label="Tasks">
      <div className="mb-1 flex items-center gap-2">
        <ListTodo className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-medium">Tasks</h3>
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground">
        Open work in this project. Models in its chats see what&apos;s still to do. Tasks found in a
        chat wait for your review in Memory suggestions.
      </p>
      <div className="mb-2 flex gap-2">
        <Input
          aria-label="New task"
          className="h-8 text-xs"
          maxLength={500}
          placeholder="e.g. Order the oak samples"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" size="sm" disabled={!text.trim()} onClick={add}>
          Add task
        </Button>
      </div>
      {current.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Nothing to do.</p>
      ) : (
        <ul className="space-y-0.5" aria-label="Open tasks">
          {current.map(row)}
        </ul>
      )}
      {finished.length > 0 && (
        <details className="mt-2 text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">
            Finished ({finished.length})
          </summary>
          <ul className="mt-1 space-y-0.5" aria-label="Finished tasks">
            {finished.map(row)}
          </ul>
        </details>
      )}
    </section>
  );
}
