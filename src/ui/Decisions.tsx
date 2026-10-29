import { Gavel, Pencil, Plus, Replace, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const textareaClass =
  "block min-h-14 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-xs leading-5 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/** One of a project's decisions (PM-15). */
export interface DecisionView {
  id: string;
  text: string;
  rationale: string | null;
  alternatives: string[];
  /** Replaced decisions stay as history. */
  status: "active" | "superseded";
  /** Text of the decision that replaced it. */
  replacedBy: string | null;
  /** e.g. "Oct 29" */
  date: string;
}

export interface DecisionInputView {
  text: string;
  rationale: string;
  alternatives: string[];
}

export interface DecisionsProps {
  decisions: DecisionView[];
  /** With `replacesId`, the new decision replaces that one (kept as history). */
  onAdd: (d: DecisionInputView, replacesId?: string) => void;
  onEdit: (id: string, d: DecisionInputView) => void;
  onDelete: (id: string) => void;
}

/** "a\nb" ⇄ ["a", "b"] for the ruled-out options. */
const toLines = (items: string[]) => items.join("\n");
const fromLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

interface Draft {
  /** null: a new decision. */
  id: string | null;
  replaces: DecisionView | null;
  text: string;
  rationale: string;
  alternatives: string;
}

function DecisionForm({
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div
      className="space-y-2 rounded-lg border p-3"
      role="group"
      aria-label={draft.id ? "Edit decision" : "New decision"}
    >
      {draft.replaces && (
        <p className="text-[11px] text-muted-foreground">
          Replaces: <span className="line-through">{draft.replaces.text}</span>
        </p>
      )}
      <Input
        aria-label="Decision"
        className="h-8 text-xs"
        maxLength={500}
        placeholder="e.g. Use oak worktops, not laminate."
        value={draft.text}
        onChange={(e) => {
          onChange({ ...draft, text: e.target.value });
        }}
      />
      <textarea
        aria-label="Why"
        className={textareaClass}
        maxLength={1000}
        placeholder="Why: e.g. They last longer and the budget allows it."
        value={draft.rationale}
        onChange={(e) => {
          onChange({ ...draft, rationale: e.target.value });
        }}
      />
      <textarea
        aria-label="Ruled out"
        className={textareaClass}
        placeholder="Options ruled out, one per line"
        value={draft.alternatives}
        onChange={(e) => {
          onChange({ ...draft, alternatives: e.target.value });
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!draft.text.trim()} onClick={onSave}>
          {draft.id ? "Save decision" : "Add decision"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Project settings → Decisions (PM-15): the project's explicit choices, with why and what was
 * ruled out. Only you add them; every model in the project's chats gets them first.
 */
export function DecisionsSection({ decisions, onAdd, onEdit, onDelete }: DecisionsProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const active = decisions.filter((d) => d.status === "active");
  const replaced = decisions.filter((d) => d.status === "superseded");
  const blank = (replaces: DecisionView | null = null): Draft => ({
    id: null,
    replaces,
    text: "",
    rationale: "",
    alternatives: "",
  });
  const save = () => {
    if (!draft) return;
    const input = {
      text: draft.text,
      rationale: draft.rationale,
      alternatives: fromLines(draft.alternatives),
    };
    if (draft.id) onEdit(draft.id, input);
    else onAdd(input, draft.replaces?.id);
    setDraft(null);
  };
  return (
    <section aria-label="Decisions">
      <div className="mb-1 flex items-center gap-2">
        <Gavel className="size-3.5 text-muted-foreground" />
        <h3 className="flex-1 text-xs font-medium">Decisions</h3>
        {!draft && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setDraft(blank());
            }}
          >
            <Plus />
            Add decision
          </Button>
        )}
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground">
        Choices this project has made. Every model in the project&apos;s chats gets them first, and
        a suggested memory never overrides them. Only you add them.
      </p>
      {draft && !draft.id && (
        <DecisionForm
          draft={draft}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
          }}
          onSave={save}
        />
      )}
      {active.length === 0 && !draft ? (
        <p className="text-[11px] text-muted-foreground">No decisions yet.</p>
      ) : (
        <ul className="mt-1 space-y-1" aria-label="Decisions in force">
          {active.map((d) =>
            draft?.id === d.id ? (
              <li key={d.id}>
                <DecisionForm
                  draft={draft}
                  onChange={setDraft}
                  onCancel={() => {
                    setDraft(null);
                  }}
                  onSave={save}
                />
              </li>
            ) : (
              <li
                key={d.id}
                className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1 text-xs leading-5">
                  <p className="font-medium">{d.text}</p>
                  {d.rationale && <p className="text-muted-foreground">Why: {d.rationale}</p>}
                  {d.alternatives.length > 0 && (
                    <p className="text-muted-foreground">Ruled out: {d.alternatives.join("; ")}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground">{d.date}</p>
                </div>
                <div className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Edit decision: ${d.text}`}
                    onClick={() => {
                      setDraft({
                        id: d.id,
                        replaces: null,
                        text: d.text,
                        rationale: d.rationale ?? "",
                        alternatives: toLines(d.alternatives),
                      });
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Replace decision: ${d.text}`}
                    onClick={() => {
                      setDraft(blank(d));
                    }}
                  >
                    <Replace />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete decision: ${d.text}`}
                    onClick={() => {
                      onDelete(d.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {replaced.length > 0 && (
        <details className="mt-2 text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">
            Replaced decisions ({replaced.length})
          </summary>
          <ul className="mt-1 space-y-1" aria-label="Replaced decisions">
            {replaced.map((d) => (
              <li key={d.id}>
                <span className="text-muted-foreground line-through">{d.text}</span>
                {d.replacedBy && <span className="text-muted-foreground"> → {d.replacedBy}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
