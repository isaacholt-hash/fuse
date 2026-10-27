import { Brain, Check, Copy, Pencil, Search, Trash2, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { number } from "./format";
import { Modal, Tip } from "./primitives";
import { CATEGORY_LABELS } from "./memoryLabels";
import type { MemoryCategoryView, MemoryForm, MemoryView, ProposalView } from "./types";

const textareaClass =
  "block min-h-16 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";
const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-xs";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as MemoryCategoryView[];

interface ProjectOption {
  id: string;
  name: string;
}

function MemoryFields({
  form,
  projects,
  onChange,
  label,
}: {
  form: MemoryForm;
  projects: ProjectOption[];
  onChange: (form: MemoryForm) => void;
  label: string;
}) {
  const id = useId();
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
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Category"
          className={selectClass}
          value={form.category}
          onChange={(e) => {
            onChange({ ...form, category: e.target.value as MemoryCategoryView });
          }}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <select
          aria-label="Used in"
          className={selectClass}
          value={form.projectId ?? ""}
          onChange={(e) => {
            onChange({ ...form, projectId: e.target.value || null });
          }}
        >
          <option value="">Every chat</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              Only in {p.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function MemoryRow({
  memory,
  projects,
  onEdit,
  onDelete,
}: {
  memory: MemoryView;
  projects: ProjectOption[];
  onEdit: (form: MemoryForm) => string | null;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<MemoryForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (draft) {
    return (
      <li className="rounded-lg border p-3">
        <MemoryFields form={draft} projects={projects} onChange={setDraft} label="Memory text" />
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
  const meta = [
    memory.projectName ? `only in ${memory.projectName}` : null,
    memory.source ? `from “${memory.source}”` : null,
    memory.date,
    memory.confidence < 100 ? `${String(memory.confidence)}% sure` : null,
  ].filter(Boolean);
  return (
    <li className="group flex items-start gap-2 rounded-lg px-3 py-2 hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-6">{memory.text}</p>
        <p className="text-[10px] text-muted-foreground">{meta.join(" · ")}</p>
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Edit memory: ${memory.text}`}
          onClick={() => {
            setDraft({ text: memory.text, category: memory.category, projectId: memory.projectId });
          }}
        >
          <Pencil />
        </Button>
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
}: {
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
  const empty: MemoryForm = { text: "", category: "fact", projectId: null };
  const [draft, setDraft] = useState<MemoryForm>(empty);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState(String(budgetTokens));
  const [wiping, setWiping] = useState(false);
  const [copied, setCopied] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = q
    ? memories.filter(
        (m) => m.text.toLowerCase().includes(q) || m.source?.toLowerCase().includes(q),
      )
    : memories;
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
        <MemoryFields form={draft} projects={projects} onChange={setDraft} label="New memory" />
        {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            disabled={!draft.text.trim()}
            onClick={() => {
              const problem = onAdd(draft);
              setError(problem);
              if (!problem) setDraft({ ...empty, category: draft.category });
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
          {CATEGORIES.map((c) => {
            const list = shown.filter((m) => m.category === c);
            if (list.length === 0) return null;
            return (
              <div key={c} className="mb-3">
                <h3 className="mb-1 px-3 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {CATEGORY_LABELS[c]}
                </h3>
                <ul aria-label={CATEGORY_LABELS[c]}>
                  {list.map((m) => (
                    <MemoryRow
                      key={m.id}
                      memory={m}
                      projects={projects}
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
              {number(memories.length)} memor{memories.length === 1 ? "y" : "ies"} · ~
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
}: {
  proposal: ProposalView;
  onKeep: (text: string) => void;
  onSkip: () => void;
}) {
  const [text, setText] = useState(proposal.text);
  const meta = [
    CATEGORY_LABELS[proposal.category],
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
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onSkip}>
          <X />
          Skip
        </Button>
        <Button
          size="sm"
          disabled={proposal.op !== "delete" && !text.trim()}
          onClick={() => {
            onKeep(text);
          }}
        >
          <Check />
          {proposal.op === "delete" ? "Forget it" : "Keep"}
        </Button>
      </div>
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
}) {
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
              />
            ))}
          </ul>
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
