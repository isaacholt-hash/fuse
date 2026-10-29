import { BookMarked, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "./primitives";

export interface PromptView {
  id: string;
  name: string;
  body: string;
  projectId: string | null;
}

const textareaClass =
  "w-full resize-y rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Settings → Prompt library (CH-12): saved prompts, for every chat or one project. */
export function PromptsSection({
  prompts,
  projects,
  onSave,
  onDelete,
}: {
  prompts: PromptView[];
  projects: { id: string; name: string }[];
  onSave: (prompt: { id?: string; name: string; body: string; projectId: string | null }) => void;
  onDelete: (id: string) => void;
}) {
  const empty = { id: undefined as string | undefined, name: "", body: "", projectId: "" };
  const [form, setForm] = useState(empty);
  const valid = form.name.trim() !== "" && form.body.trim() !== "";
  const where = (id: string | null) =>
    id === null ? "Every chat" : (projects.find((p) => p.id === id)?.name ?? "A project");
  return (
    <section className="mt-8 border-t pt-6" aria-label="Prompt library">
      <div className="mb-1 flex items-center gap-2">
        <BookMarked className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Prompt library</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Prompts you use again. Type / in the message box or find them in the palette (Ctrl+Shift+P).
        Write {"{{name}}"} for a part you fill in each time.
      </p>
      {prompts.length > 0 && (
        <ul className="mb-3 space-y-1" aria-label="Saved prompts">
          {prompts.map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate">
                {p.name}{" "}
                <span className="text-[10px] text-muted-foreground">{where(p.projectId)}</span>
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Edit ${p.name}`}
                onClick={() => {
                  setForm({ id: p.id, name: p.name, body: p.body, projectId: p.projectId ?? "" });
                }}
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete ${p.name}`}
                onClick={() => {
                  onDelete(p.id);
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="space-y-2"
        aria-label={form.id ? "Edit prompt" : "New prompt"}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onSave({
            ...(form.id ? { id: form.id } : {}),
            name: form.name.trim(),
            body: form.body,
            projectId: form.projectId || null,
          });
          setForm(empty);
        }}
      >
        <div className="flex gap-2">
          <Input
            aria-label="Prompt name"
            placeholder="Name, e.g. Summarize for my boss"
            className="h-8 text-xs"
            value={form.name}
            onChange={(e) => {
              setForm((f) => ({ ...f, name: e.target.value }));
            }}
          />
          <select
            aria-label="Prompt for"
            className="h-8 rounded-lg border bg-transparent px-2 text-xs"
            value={form.projectId}
            onChange={(e) => {
              setForm((f) => ({ ...f, projectId: e.target.value }));
            }}
          >
            <option value="">Every chat</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <textarea
          aria-label="Prompt text"
          rows={4}
          placeholder={"e.g. Summarize this for {{audience}} in three bullet points:"}
          className={textareaClass}
          value={form.body}
          onChange={(e) => {
            setForm((f) => ({ ...f, body: e.target.value }));
          }}
        />
        <div className="flex gap-2">
          <Button size="sm" type="submit" disabled={!valid}>
            {form.id ? "Save prompt" : "Add prompt"}
          </Button>
          {form.id && (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => {
                setForm(empty);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

/** Fills a prompt's {{variables}} before it goes into the message box. */
export function FillPromptDialog({
  name,
  variables,
  onCancel,
  onFill,
}: {
  name: string;
  variables: string[];
  onCancel: () => void;
  onFill: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={name}
      description="Fill in the blanks; the prompt goes into the message box for you to check."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onFill(values);
        }}
      >
        {variables.map((v, i) => (
          <label key={v} className="flex flex-col gap-1 text-xs">
            {v}
            <Input
              aria-label={v}
              autoFocus={i === 0}
              value={values[v] ?? ""}
              onChange={(e) => {
                setValues((all) => ({ ...all, [v]: e.target.value }));
              }}
            />
          </label>
        ))}
        <div className="flex justify-end">
          <Button size="sm" type="submit">
            Use prompt
          </Button>
        </div>
      </form>
    </Modal>
  );
}
