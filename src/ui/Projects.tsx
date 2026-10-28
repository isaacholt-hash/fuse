import { FileText, LoaderCircle, Paperclip, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money, number } from "./format";
import { Modal } from "./primitives";
import type { ModelOption, ProjectForm } from "./types";

const LAST_USED = "";

/** A project knowledge file (PM-09). */
export interface KnowledgeFileView {
  id: string;
  name: string;
  tokens: number;
  /** "Searchable", "Indexing…", "Needs an OpenAI key", or an error. */
  status: string;
  ready: boolean;
  /** What sending it whole with every message would cost, for comparison. */
  wholeMicro: number;
}

export interface KnowledgeProps {
  files: KnowledgeFileView[];
  busy: boolean;
  error: string | null;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
}

/** Project settings → Knowledge: files every chat in the project searches. */
function KnowledgeSection({ files, busy, error, onAdd, onRemove }: KnowledgeProps) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <section aria-label="Knowledge files">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-medium">Knowledge</h3>
        <input
          ref={picker}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.csv,.json,.docx,.html,.xml,.yaml,.yml,.ts,.tsx,.js,.py,.rs,.go,.java,.sql"
          className="hidden"
          aria-label="Add knowledge files"
          onChange={(e) => {
            onAdd(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Paperclip className="size-3.5" />
          )}
          Add files
        </Button>
      </div>
      <p className="mb-2 text-[10px] leading-4 text-muted-foreground">
        Text, Markdown, Word, CSV and code. Indexed once, then every chat in this project gets the
        parts that match each question (about 3,000 tokens) instead of whole files.
      </p>
      {error && (
        <p role="alert" className="mb-2 text-[11px] text-destructive">
          {error}
        </p>
      )}
      {files.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No files yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px]"
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{f.name}</span>
                <span className="block font-mono text-[10px] text-muted-foreground">
                  ~{number(f.tokens)} tokens · {money(f.wholeMicro)} a message if sent whole
                </span>
              </span>
              <span
                className={`shrink-0 text-[10px] ${f.ready ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}`}
              >
                {f.status}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${f.name}`}
                onClick={() => {
                  onRemove(f.id);
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
const modelKey = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** Create or edit a project: name, instructions and default model (PM-01). */
export function ProjectDialog({
  open,
  onOpenChange,
  initial,
  models,
  maxChars,
  onSave,
  onDelete,
  knowledge,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null when creating a new project. */
  initial: ProjectForm | null;
  models: ModelOption[];
  maxChars: number;
  onSave: (form: ProjectForm) => void;
  /** Only when editing. */
  onDelete?: () => void;
  /** Only when editing: the project's knowledge files (PM-09). */
  knowledge?: KnowledgeProps;
}) {
  const empty: ProjectForm = { name: "", instructions: "", defaultModel: null };
  const [form, setForm] = useState<ProjectForm>(initial ?? empty);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ids = { name: useId(), instructions: useId(), model: useId() };
  const editing = initial !== null;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setForm(initial ?? empty);
          setConfirmDelete(false);
        }
        onOpenChange(next);
      }}
      title={editing ? "Project settings" : "New project"}
      description="Chats in a project share its instructions and start on its default model."
      wide
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.name.trim()) onSave(form);
        }}
      >
        <div>
          <label htmlFor={ids.name} className="mb-1.5 block text-xs font-medium">
            Name
          </label>
          <Input
            id={ids.name}
            autoFocus
            maxLength={80}
            placeholder="e.g. Kitchen renovation"
            value={form.name}
            onChange={(e) => {
              setForm((f) => ({ ...f, name: e.target.value }));
            }}
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label htmlFor={ids.instructions} className="text-xs font-medium">
              Project instructions
            </label>
            <span className="font-mono text-[10px] text-muted-foreground">
              {number(form.instructions.length)} / {number(maxChars)}
            </span>
          </div>
          <textarea
            id={ids.instructions}
            className="block min-h-28 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            maxLength={maxChars}
            placeholder="e.g. Budget is fixed. Prefer options a beginner can do. Quote prices in GBP."
            value={form.instructions}
            onChange={(e) => {
              setForm((f) => ({ ...f, instructions: e.target.value }));
            }}
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Added after your global instructions, before any chat&apos;s own.
          </p>
        </div>
        <div>
          <label htmlFor={ids.model} className="mb-1.5 block text-xs font-medium">
            Default model
          </label>
          <select
            id={ids.model}
            className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
            value={form.defaultModel ? modelKey(form.defaultModel) : LAST_USED}
            onChange={(e) => {
              const m = models.find((x) => modelKey(x) === e.target.value);
              setForm((f) => ({
                ...f,
                defaultModel: m ? { provider: m.provider, id: m.id } : null,
              }));
            }}
          >
            <option value={LAST_USED}>Auto</option>
            {models.map((m) => (
              <option key={modelKey(m)} value={modelKey(m)}>
                {m.providerName} · {m.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-muted-foreground">
            New chats in this project start on it. You can still change it in any chat.
          </p>
        </div>
        {knowledge && <KnowledgeSection {...knowledge} />}
        <div className="flex items-center gap-2 pt-2">
          {onDelete &&
            (confirmDelete ? (
              <>
                <span className="text-[11px] text-muted-foreground">
                  Delete? Its chats are kept.
                </span>
                <Button type="button" variant="destructive" size="sm" onClick={onDelete}>
                  Delete project
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                Delete…
              </Button>
            ))}
          <Button type="submit" size="sm" className="ml-auto" disabled={!form.name.trim()}>
            {editing ? "Save" : "Create project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
