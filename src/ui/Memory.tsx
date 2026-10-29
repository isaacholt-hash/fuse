import { Brain, Check, Copy, Eye, EyeOff, Pencil, Search, Trash2, X } from "lucide-react";
import { Fragment, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { number } from "./format";
import { Modal, Tip } from "./primitives";
import { ADDABLE_KINDS, KIND_LABELS } from "./memoryLabels";
import type { MemoryKindView, MemoryForm, MemoryView, ProposalView } from "./types";

const textareaClass =
  "block min-h-16 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";
const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-xs";

const KINDS = Object.keys(KIND_LABELS) as MemoryKindView[];

interface ProjectOption {
  id: string;
  name: string;
}

/** A chat a memory can be kept for (PM-13). */
interface ChatOption {
  id: string;
  title: string;
}

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
/** yyyy-mm-dd in local time, for a date input. */
const dateValue = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** The end of that day, local time. */
const endOfDay = (value: string) => new Date(`${value}T23:59:59`).getTime();

function MemoryFields({
  form,
  projects,
  chats,
  onChange,
  label,
}: {
  form: MemoryForm;
  projects: ProjectOption[];
  /** Chats it can be kept for: the open one, and the one it already belongs to. */
  chats: ChatOption[];
  onChange: (form: MemoryForm) => void;
  label: string;
}) {
  const id = useId();
  const where = form.threadId ? `t:${form.threadId}` : form.projectId ? `p:${form.projectId}` : "";
  return (
    <div className="space-y-2">
      <textarea
        id={id}
        aria-label={label}
        className={textareaClass}
        placeholder="e.g. Prefers metric units. Has a daughter, Maya, aged 7."
        value={form.text}
        maxLength={500}
        onChange={(e) => {
          onChange({ ...form, text: e.target.value });
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Kind"
          className={selectClass}
          value={form.kind}
          onChange={(e) => {
            onChange({ ...form, kind: e.target.value as MemoryKindView });
          }}
        >
          {(ADDABLE_KINDS.includes(form.kind) ? ADDABLE_KINDS : [...ADDABLE_KINDS, form.kind]).map(
            (c) => (
              <option key={c} value={c}>
                {KIND_LABELS[c]}
              </option>
            ),
          )}
        </select>
        <select
          aria-label="Used in"
          className={selectClass}
          value={where}
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              ...form,
              projectId: v.startsWith("p:") ? v.slice(2) : null,
              threadId: v.startsWith("t:") ? v.slice(2) : null,
            });
          }}
        >
          <option value="">Every chat</option>
          {projects.map((p) => (
            <option key={p.id} value={`p:${p.id}`}>
              Only in {p.name}
            </option>
          ))}
          {chats.map((c) => (
            <option key={c.id} value={`t:${c.id}`}>
              Only in the chat “{c.title}”
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs">
          Expires
          <input
            type="date"
            aria-label="Expires on"
            className={selectClass}
            value={form.expiresAt ? dateValue(form.expiresAt) : ""}
            onChange={(e) => {
              onChange({ ...form, expiresAt: e.target.value ? endOfDay(e.target.value) : null });
            }}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={form.sensitivity === "sensitive"}
            onChange={(e) => {
              onChange({ ...form, sensitivity: e.target.checked ? "sensitive" : "normal" });
            }}
          />
          Sensitive
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={form.maySend === false}
            onChange={(e) => {
              onChange({ ...form, maySend: !e.target.checked });
            }}
          />
          Keep on this device (never sent to a model)
        </label>
      </div>
    </div>
  );
}

const AUTHORITY: Record<MemoryView["authority"], string> = {
  you: "added by you",
  imported: "imported",
  extracted: "suggested after a chat",
};

/** The short line under a memory: where it applies, who added it, and its flags. */
function metaLine(m: MemoryView): string {
  return [
    m.projectName ? `only in ${m.projectName}` : null,
    m.threadName ? `only in “${m.threadName}”` : null,
    AUTHORITY[m.authority],
    m.source ? `from “${m.source}”` : null,
    m.date,
    m.confidence < 100 ? `${String(m.confidence)}% sure` : null,
    m.sensitivity === "sensitive" ? "sensitive" : null,
    m.maySend ? null : "kept on this device",
    m.status === "expired"
      ? "expired"
      : m.expiresAt !== null
        ? `expires ${day(m.expiresAt)}`
        : null,
    m.status === "excluded" ? "excluded" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Provenance in full (PM-14). */
function Provenance({ m }: { m: MemoryView }) {
  const rows: [string, string][] = [
    ["Kind", KIND_LABELS[m.kind]],
    [
      "Used in",
      m.threadName
        ? `the chat “${m.threadName}”`
        : m.projectName
          ? `the project ${m.projectName}`
          : "every chat",
    ],
    [
      "Added",
      `${AUTHORITY[m.authority]}${m.extractionMethod === "import" ? " (pasted from another app)" : ""}`,
    ],
    ...(m.source ? [["From chat", m.source] as [string, string]] : []),
    ...(m.extractionModel ? [["Found by", m.extractionModel] as [string, string]] : []),
    ["Confidence", `${String(m.confidence)}%`],
    ["Last checked", m.lastVerifiedAt ? day(m.lastVerifiedAt) : "never"],
    ["Expires", m.expiresAt ? day(m.expiresAt) : "never"],
    ["Sent to models", m.maySend ? "when relevant" : "never"],
    ["Version", String(m.revision)],
  ];
  return (
    <details className="mt-0.5 text-[10px] text-muted-foreground">
      <summary className="cursor-pointer select-none">Details</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd className="text-foreground/80">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

function MemoryRow({
  memory,
  projects,
  chats,
  onEdit,
  onDelete,
  onExclude,
}: {
  memory: MemoryView;
  projects: ProjectOption[];
  chats: ChatOption[];
  onEdit: (form: MemoryForm) => string | null;
  onDelete: () => void;
  /** PM-17: leave it out of future context (true) or bring it back. */
  onExclude?: (excluded: boolean) => void;
}) {
  const [draft, setDraft] = useState<MemoryForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (draft) {
    const own =
      memory.threadId && !chats.some((c) => c.id === memory.threadId)
        ? [{ id: memory.threadId, title: memory.threadName ?? "a chat" }]
        : [];
    return (
      <li className="rounded-lg border p-3">
        <MemoryFields
          form={draft}
          projects={projects}
          chats={[...chats, ...own]}
          onChange={setDraft}
          label="Memory text"
        />
        {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!draft.text.trim()}
            onClick={() => {
              const problem = onEdit(draft);
              setError(problem);
              if (!problem) setDraft(null);
            }}
          >
            Save
          </Button>
        </div>
      </li>
    );
  }
  return (
    <li className="group flex items-start gap-2 rounded-lg px-3 py-2 hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <p
          className={
            memory.status === "active"
              ? "text-sm leading-6"
              : "text-sm leading-6 text-muted-foreground"
          }
        >
          {memory.text}
        </p>
        <p className="text-[10px] text-muted-foreground">{metaLine(memory)}</p>
        <Provenance m={memory} />
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Edit memory: ${memory.text}`}
          onClick={() => {
            setDraft({
              text: memory.text,
              kind: memory.kind,
              projectId: memory.projectId,
              threadId: memory.threadId,
              sensitivity: memory.sensitivity,
              maySend: memory.maySend,
              expiresAt: memory.expiresAt,
            });
          }}
        >
          <Pencil />
        </Button>
        {onExclude && memory.status !== "expired" && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={
              memory.status === "excluded"
                ? `Include memory again: ${memory.text}`
                : `Exclude memory: ${memory.text}`
            }
            onClick={() => {
              onExclude(memory.status !== "excluded");
            }}
          >
            {memory.status === "excluded" ? <Eye /> : <EyeOff />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete memory: ${memory.text}`}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

type WhereFilter = "any" | "global" | "project" | "chat";
type StatusFilter = "in_use" | "not_in_use" | "all";

const matchesWhere = (m: MemoryView, f: WhereFilter) =>
  f === "any" ||
  (f === "chat"
    ? m.threadId !== null
    : f === "project"
      ? m.projectId !== null && !m.threadId
      : !m.projectId && !m.threadId);
const matchesStatus = (m: MemoryView, f: StatusFilter) =>
  f === "all" || (f === "in_use") === (m.status === "active");

/** Settings → Memory (PM-02, PM-07): everything FUSE remembers, editable. */
export function MemorySection({
  memories,
  projects,
  suggest,
  budgetTokens,
  tokens,
  pendingCount,
  onAdd,
  onEdit,
  onDelete,
  onDeleteAll,
  onSettings,
  onReview,
  onCopyAll,
  replaced = [],
  onRestore,
  currentChat = null,
  onExclude,
}: {
  /** PM-17: excludes a memory from context without deleting it, or includes it again. */
  onExclude?: (id: string, excluded: boolean) => void;
  /** The chat open behind Settings, so a memory can be kept for it only (PM-13). */
  currentChat?: ChatOption | null;
  /** PM-11: facts replaced by newer ones, kept as history. */
  replaced?: { id: string; text: string; newer: string }[];
  onRestore?: (id: string) => void;
  /** In use, excluded and expired records (PM-12 to PM-14). */
  memories: MemoryView[];
  projects: ProjectOption[];
  suggest: boolean;
  budgetTokens: number;
  /** Rough tokens of all saved memories. */
  tokens: number;
  pendingCount: number;
  /** Returns a problem to show (e.g. it looks like a password), or null when saved. */
  onAdd: (form: MemoryForm) => string | null;
  onEdit: (id: string, form: MemoryForm) => string | null;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  onSettings: (value: { suggest: boolean; budgetTokens: number }) => void;
  onReview: () => void;
  onCopyAll: () => void;
}) {
  const empty: MemoryForm = { text: "", kind: "fact", projectId: null };
  const [draft, setDraft] = useState<MemoryForm>(empty);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState(String(budgetTokens));
  const [wiping, setWiping] = useState(false);
  const [copied, setCopied] = useState(false);
  const [kindFilter, setKindFilter] = useState<MemoryKindView | "all">("all");
  const [whereFilter, setWhereFilter] = useState<WhereFilter>("any");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("in_use");
  const chats = currentChat ? [currentChat] : [];
  const inUse = memories.filter((m) => m.status === "active");
  const q = query.trim().toLowerCase();
  const shown = memories.filter(
    (m) =>
      (!q || m.text.toLowerCase().includes(q) || m.source?.toLowerCase().includes(q)) &&
      (kindFilter === "all" || m.kind === kindFilter) &&
      matchesWhere(m, whereFilter) &&
      matchesStatus(m, statusFilter),
  );
  const saveBudget = () => {
    const n = Math.round(Number(budget));
    if (Number.isFinite(n) && n >= 0 && n !== budgetTokens) {
      onSettings({ suggest, budgetTokens: n });
    } else {
      setBudget(String(budgetTokens));
    }
  };
  return (
    <section className="mt-8 border-t pt-6" aria-label="Memory">
      <div className="mb-1 flex items-center gap-2">
        <Brain className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Memory</h2>
      </div>
      <p className="mb-4 text-[11px] text-muted-foreground">
        Facts sent to any model when they’re relevant. After a chat, a cheap model suggests new
        ones; nothing is saved until you keep it. Passwords, keys, card, account and ID numbers are
        never stored.
      </p>

      {pendingCount > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2 text-xs">
          <span className="flex-1">
            {number(pendingCount)} suggestion{pendingCount === 1 ? "" : "s"} waiting for review
          </span>
          <Button size="xs" onClick={onReview}>
            Review
          </Button>
        </div>
      )}

      <div className="mb-5 space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={suggest}
            onChange={(e) => {
              onSettings({ suggest: e.target.checked, budgetTokens });
            }}
          />
          Suggest memories when I leave a chat
        </label>
        <label className="flex items-center gap-2">
          Send up to
          <Input
            aria-label="Memory budget per message (tokens)"
            className="h-7 w-20 text-xs"
            inputMode="numeric"
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value);
            }}
            onBlur={saveBudget}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveBudget();
            }}
          />
          tokens of memories per message (0 turns memory off)
        </label>
      </div>

      <div className="mb-5">
        <MemoryFields
          form={draft}
          projects={projects}
          chats={chats}
          onChange={setDraft}
          label="New memory"
        />
        {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            disabled={!draft.text.trim()}
            onClick={() => {
              const problem = onAdd(draft);
              setError(problem);
              if (!problem) setDraft({ ...empty, kind: draft.kind, projectId: draft.projectId });
            }}
          >
            Add memory
          </Button>
        </div>
      </div>

      {memories.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No memories yet.</p>
      ) : (
        <>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search memories"
              placeholder="Search memories"
              className="h-8 pl-8 text-xs"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
            />
          </div>
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter memories">
            <select
              aria-label="Show kind"
              className={selectClass}
              value={kindFilter}
              onChange={(e) => {
                setKindFilter(e.target.value as MemoryKindView | "all");
              }}
            >
              <option value="all">All kinds</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <select
              aria-label="Show where used"
              className={selectClass}
              value={whereFilter}
              onChange={(e) => {
                setWhereFilter(e.target.value as WhereFilter);
              }}
            >
              <option value="any">Used anywhere</option>
              <option value="global">Every chat</option>
              <option value="project">One project</option>
              <option value="chat">One chat</option>
            </select>
            <select
              aria-label="Show status"
              className={selectClass}
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as StatusFilter);
              }}
            >
              <option value="in_use">In use</option>
              <option value="not_in_use">Excluded or expired</option>
              <option value="all">All</option>
            </select>
          </div>
          {KINDS.map((c) => {
            const list = shown.filter((m) => m.kind === c);
            if (list.length === 0) return null;
            return (
              <div key={c} className="mb-3">
                <h3 className="mb-1 px-3 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {KIND_LABELS[c]}
                </h3>
                <ul aria-label={KIND_LABELS[c]}>
                  {list.map((m) => (
                    <MemoryRow
                      key={m.id}
                      memory={m}
                      projects={projects}
                      chats={chats}
                      {...(onExclude
                        ? {
                            onExclude: (excluded: boolean) => {
                              onExclude(m.id, excluded);
                            },
                          }
                        : {})}
                      onEdit={(form) => onEdit(m.id, form)}
                      onDelete={() => {
                        onDelete(m.id);
                      }}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
          {shown.length === 0 && (
            <p className="px-3 text-[11px] text-muted-foreground">No memories match.</p>
          )}
          <div className="mt-4 flex items-center gap-2">
            <span className="flex-1 font-mono text-[10px] text-muted-foreground">
              {number(inUse.length)} memor{inUse.length === 1 ? "y" : "ies"} in use · ~
              {number(tokens)} tokens
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onCopyAll();
                setCopied(true);
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy all"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => {
                setWiping(true);
              }}
            >
              Delete all…
            </Button>
          </div>
        </>
      )}
      {replaced.length > 0 && (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Replaced facts ({replaced.length})
          </summary>
          <ul className="mt-2 space-y-1.5" aria-label="Replaced facts">
            {replaced.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className="flex-1">
                  <span className="text-muted-foreground line-through">{r.text}</span>
                  <span className="text-muted-foreground"> → {r.newer}</span>
                </span>
                {onRestore && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onRestore(r.id);
                    }}
                  >
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Modal
        open={wiping}
        onOpenChange={setWiping}
        title="Delete all memories?"
        description="Every saved memory and every waiting suggestion is removed. Your chats are kept."
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setWiping(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setWiping(false);
              onDeleteAll();
            }}
          >
            Delete all memories
          </Button>
        </div>
      </Modal>
    </section>
  );
}

const OP_LABELS: Record<ProposalView["op"], string> = {
  add: "New",
  update: "Update",
  delete: "Forget",
};

function ProposalRow({
  proposal,
  onKeep,
  onSkip,
  onReplace,
}: {
  proposal: ProposalView;
  onKeep: (text: string) => void;
  onSkip: () => void;
  /** PM-11: keep this and retire the fact it contradicts (kept as history). */
  onReplace?: (text: string) => void;
}) {
  const [text, setText] = useState(proposal.text);
  const meta = [
    KIND_LABELS[proposal.kind],
    proposal.projectName ? `only in ${proposal.projectName}` : null,
    proposal.source ? `from “${proposal.source}”` : null,
    `${String(proposal.confidence)}% sure`,
  ].filter(Boolean);
  return (
    <li className="rounded-lg border p-3" aria-label={`${OP_LABELS[proposal.op]} memory`}>
      <div className="mb-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
          {OP_LABELS[proposal.op]}
        </span>
        <span className="truncate">{meta.join(" · ")}</span>
      </div>
      {proposal.currentText && (
        <p
          className={`mb-2 text-xs text-muted-foreground ${proposal.op === "delete" ? "line-through" : ""}`}
        >
          {proposal.op === "update" ? `Was: ${proposal.currentText}` : proposal.currentText}
        </p>
      )}
      {proposal.conflict && (
        <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs">
          This may contradict what&apos;s saved:{" "}
          <strong className="font-medium">{proposal.conflict.text}</strong>. Which stands?
        </p>
      )}
      {proposal.op !== "delete" && (
        <textarea
          aria-label="Suggested memory"
          className={textareaClass}
          value={text}
          maxLength={500}
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
      )}
      {proposal.conflict && onReplace ? (
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onSkip}>
            Keep the old one
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!text.trim()}
            onClick={() => {
              onKeep(text);
            }}
          >
            Keep both
          </Button>
          <Button
            size="sm"
            disabled={!text.trim()}
            onClick={() => {
              onReplace(text);
            }}
          >
            <Check />
            Keep the new one
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onSkip}>
            <X />
            {proposal.op === "update" ? "Keep the old one" : "Skip"}
          </Button>
          <Button
            size="sm"
            disabled={proposal.op !== "delete" && !text.trim()}
            onClick={() => {
              onKeep(text);
            }}
          >
            <Check />
            {proposal.op === "delete"
              ? "Forget it"
              : proposal.op === "update"
                ? "Keep the new one"
                : "Keep"}
          </Button>
        </div>
      )}
    </li>
  );
}

/** Reviewing what the Cheap model suggested (PM-03); secrets it found are named, never shown. */
export function MemoryReviewDialog({
  open,
  onOpenChange,
  proposals,
  skipped,
  onKeep,
  onSkip,
  onKeepAll,
  onSkipAll,
  onReplace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proposals: ProposalView[];
  /** e.g. ["a password or PIN"]: suggestions dropped by the secrets filter. */
  skipped: string[];
  onKeep: (id: string, text: string) => void;
  onSkip: (id: string) => void;
  onKeepAll: () => void;
  onSkipAll: () => void;
  /** PM-11: keep a new fact in place of the saved one it contradicts. */
  onReplace?: (id: string, text: string, replaceId: string) => void;
}) {
  const conflicts = proposals.filter((p) => p.conflict).length;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Memory suggestions"
      description="From your recent chats. Nothing is saved until you keep it. Edit the text first if it’s not quite right."
      wide
    >
      {skipped.length > 0 && (
        <p role="status" className="mb-3 rounded-lg bg-muted/60 px-3 py-2 text-[11px]">
          Skipped {skipped.length === 1 ? "1 suggestion" : `${String(skipped.length)} suggestions`}{" "}
          that looked like {[...new Set(skipped)].join(", ")}.{" "}
          {skipped.length === 1 ? "It was" : "They were"} not stored.
        </p>
      )}
      {proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No suggestions waiting.</p>
      ) : (
        <>
          <ul className="max-h-[55dvh] space-y-2 overflow-y-auto">
            {proposals.map((p) => (
              <ProposalRow
                key={p.id}
                proposal={p}
                onKeep={(text) => {
                  onKeep(p.id, text);
                }}
                onSkip={() => {
                  onSkip(p.id);
                }}
                {...(onReplace && p.conflict
                  ? {
                      onReplace: (text: string) => {
                        if (p.conflict) onReplace(p.id, text, p.conflict.id);
                      },
                    }
                  : {})}
              />
            ))}
          </ul>
          {conflicts > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Keep all leaves {conflicts === 1 ? "the one" : `the ${String(conflicts)}`} that may
              contradict a saved fact for you to decide.
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onSkipAll}>
              Skip all
            </Button>
            <Button size="sm" onClick={onKeepAll}>
              Keep all
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** The bar above the composer when suggestions are waiting (or secrets were skipped). */
export function MemoryBar({
  count,
  checking,
  skipped,
  onReview,
  onDismissSkipped,
}: {
  count: number;
  checking: boolean;
  /** What the last check skipped as secrets, e.g. ["a password or PIN"]. */
  skipped: string[];
  onReview: () => void;
  onDismissSkipped: () => void;
}) {
  if (count === 0 && !checking && skipped.length === 0) return null;
  return (
    <div
      role="status"
      aria-label="Memory suggestions"
      className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 px-8 text-[11px] text-muted-foreground max-[800px]:px-5"
    >
      <Brain className={`size-3.5 shrink-0 ${checking ? "animate-pulse" : ""}`} />
      {checking ? (
        <span>Checking the last chat for things to remember…</span>
      ) : count > 0 ? (
        <>
          <span>
            {number(count)} memory suggestion{count === 1 ? "" : "s"} from your chats
          </span>
          <Tip label="Review what FUSE suggests remembering">
            <Button variant="link" size="xs" className="px-0" onClick={onReview}>
              Review
            </Button>
          </Tip>
        </>
      ) : (
        <>
          <span>
            Skipped a memory suggestion that looked like {[...new Set(skipped)].join(", ")}. It was
            not stored.
          </span>
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismissSkipped}>
            <X />
          </Button>
        </>
      )}
    </div>
  );
}
