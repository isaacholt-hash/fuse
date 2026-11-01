import { ProjectToolsSection, type ProjectToolsProps } from "./ProjectTools";
import { FileText, LoaderCircle, Paperclip, Trash2 } from "lucide-react";
import { DecisionsSection, type DecisionsProps } from "./Decisions";
import { TasksSection, type TasksProps } from "./Tasks";
import { ProjectPrivacySection, type ProjectPrivacyProps } from "./ProjectPrivacy";
import { ProjectRepoSection, type ProjectRepoProps } from "./ProjectRepo";
import { useId, useRef, useState, type ReactNode } from "react";
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
  /** "Searchable", "Searchable by word", "Indexing…", or an error. */
  status: string;
  ready: boolean;
  /** What sending it whole with every message would cost, for comparison. */
  wholeMicro: number;
  /** SE-13: false keeps it on this device: never searched for a request or embedded. */
  maySend: boolean;
  /** FK-07: the folder it's in, for a folder's document (it follows the file, so no Remove). */
  folder?: string;
}

export interface KnowledgeProps {
  files: KnowledgeFileView[];
  busy: boolean;
  error: string | null;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onMaySend?: (id: string, maySend: boolean) => void;
}

/** Project settings → Knowledge: files every chat in the project searches. */
export function KnowledgeSection({
  files,
  busy,
  error,
  onAdd,
  onRemove,
  onMaySend,
}: KnowledgeProps) {
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
        parts that match each question (about 3,000 tokens) instead of whole files. Documents in the
        project&apos;s folders are added here too, and kept in step when they change.
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
                {f.maySend ? f.status : "Kept on this computer"}
              </span>
              {onMaySend && (
                <label className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                  <input
                    type="checkbox"
                    aria-label={`Keep ${f.name} on this computer`}
                    checked={!f.maySend}
                    onChange={(e) => {
                      onMaySend(f.id, !e.target.checked);
                    }}
                  />
                  Local
                </label>
              )}
              {f.folder ? (
                <span
                  className="shrink-0 text-[10px] text-muted-foreground"
                  title={`Kept in step with ${f.folder}: change or delete the file there.`}
                >
                  In folder
                </span>
              ) : (
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
              )}
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
  artifacts,
  onOpenArtifact,
  decisions,
  tasks,
  privacy,
  repo,
  tools,
  schedules,
  onExport,
}: {
  /** Only when editing: its scheduled tasks (M10 step 9, AG-07). */
  schedules?: ReactNode;
  /** Only when editing: the tools its Code and Work runs may use (M9 step 1, AG-01). */
  tools?: ProjectToolsProps;
  /** Only when editing: the folder the coding agent works in (CA-01). */
  repo?: ProjectRepoProps;
  /** Only when editing: saves this project as a FUSE export (PL-12); returns a line to show. */
  onExport?: () => Promise<string | null>;
  /** Only when editing: where the project's content may be sent (SE-13). */
  privacy?: ProjectPrivacyProps;
  /** Only when editing: the project's tasks (PM-16). */
  tasks?: TasksProps;
  /** Only when editing: the project's decisions (PM-15). */
  decisions?: DecisionsProps;
  /** AR-06: artifacts made in this project's chats. */
  artifacts?: { id: string; title: string; chat: string }[];
  onOpenArtifact?: (id: string) => void;
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
  const [exported, setExported] = useState<string | null>(null);
  const ids = { name: useId(), instructions: useId(), model: useId(), form: useId() };
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
        id={ids.form}
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
            value={
              form.defaultModel
                ? modelKey(form.defaultModel)
                : form.defaultTier
                  ? `tier:${form.defaultTier}`
                  : LAST_USED
            }
            onChange={(e) => {
              const value = e.target.value;
              const m = models.find((x) => modelKey(x) === value);
              setForm((f) => ({
                ...f,
                defaultModel: m ? { provider: m.provider, id: m.id } : null,
                defaultTier:
                  value === "tier:balanced" ? "balanced" : value === "tier:best" ? "best" : null,
              }));
            }}
          >
            <option value={LAST_USED}>Auto</option>
            <option value="tier:balanced">Balanced tier</option>
            <option value="tier:best">Best tier</option>
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
        {artifacts && artifacts.length > 0 && (
          <section aria-label="Project artifacts">
            <h3 className="mb-1 text-xs font-medium">Artifacts</h3>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
              {artifacts.map((a) => (
                <li key={a.id}>
                  <button
                    className="w-full truncate rounded px-2 py-1 text-left hover:bg-accent"
                    onClick={() => onOpenArtifact?.(a.id)}
                  >
                    {a.title} <span className="text-[10px] text-muted-foreground">in {a.chat}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </form>
      {/* Outside the form, so Enter in a decision doesn't save and close the project. */}
      {decisions && (
        <div className="mt-4">
          <DecisionsSection {...decisions} />
        </div>
      )}
      {tasks && (
        <div className="mt-4">
          <TasksSection {...tasks} />
        </div>
      )}
      {repo && (
        <div className="mt-4">
          <ProjectRepoSection {...repo} />
        </div>
      )}
      {tools && (
        <div className="mt-4">
          <ProjectToolsSection {...tools} />
        </div>
      )}
      {schedules && <div className="mt-4">{schedules}</div>}
      {privacy && (
        <div className="mt-4">
          <ProjectPrivacySection {...privacy} />
        </div>
      )}
      <div className="flex items-center gap-2 pt-4">
        {onDelete &&
          (confirmDelete ? (
            <>
              <span className="text-[11px] text-muted-foreground">Delete? Its chats are kept.</span>
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
        {onExport && !confirmDelete && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setExported(null);
              onExport().then(setExported, (e: unknown) => {
                setExported(e instanceof Error ? e.message : String(e));
              });
            }}
          >
            Export project…
          </Button>
        )}
        <Button
          type="submit"
          form={ids.form}
          size="sm"
          className="ml-auto"
          disabled={!form.name.trim()}
        >
          {editing ? "Save" : "Create project"}
        </Button>
      </div>
      {exported && (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {exported}
        </p>
      )}
    </Modal>
  );
}
