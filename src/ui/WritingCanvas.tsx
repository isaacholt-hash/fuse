import { Check, MessageSquare, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { markdownSections, type CanvasRange, type MarkdownSection } from "@/artifacts/sections";
import { Button } from "@/components/ui/button";
import { DiffView } from "./Artifacts";

export type WritingActionName = "rewrite" | "shorten" | "expand";

export type { CanvasRange };

export interface CommentView {
  id: string;
  quote: string;
  body: string;
  resolved: boolean;
  /** exact: on the latest version; review: found once, confirm the move; missing: passage gone. */
  place: "exact" | "review" | "missing";
}

export interface ProposalView {
  id: string;
  instruction: string;
  state: "requested" | "pending" | "interrupted";
  /** Base version against the candidate; null until the reply arrives. */
  diff: { kind: "same" | "add" | "del"; text: string }[] | null;
  /** The document changed after the request: it can be read and discarded, not accepted. */
  stale: boolean;
}

export interface CanvasProps {
  comments: CommentView[];
  proposals: ProposalView[];
  /** A request is being written; actions wait for it. */
  busy: boolean;
  onAction: (action: WritingActionName, range: CanvasRange) => void;
  onComment: (range: CanvasRange, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDeleteComment: (id: string) => void;
  onReattach: (id: string) => void;
  onAccept: (id: string) => void;
  onDiscard: (id: string) => void;
}

const sectionRange = (content: string, s: MarkdownSection): CanvasRange => ({
  start: s.start,
  end: s.end,
  quote: content.slice(s.start, s.end),
  title: s.level === 0 && s.title === "Whole document" ? "" : s.title,
});

const ACTIONS: { id: WritingActionName; label: string }[] = [
  { id: "rewrite", label: "Rewrite" },
  { id: "shorten", label: "Shorten" },
  { id: "expand", label: "Expand" },
];

/** The writing tools above a Markdown document (M17.2, AR-07). */
export function CanvasToolbar({
  content,
  canvas,
  selection,
}: {
  content: string;
  canvas: CanvasProps;
  /** Reads the current selection in the document, as a range, or why it can't be used. */
  selection: () => CanvasRange | "none" | "ambiguous";
}) {
  const sections = markdownSections(content);
  const [section, setSection] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<{ range: CanvasRange; body: string } | null>(null);
  const picked = sections[Math.min(section, sections.length - 1)];
  /** The selection when there is one, else the picked section. */
  const target = (): CanvasRange | null => {
    const sel = selection();
    if (sel === "ambiguous") {
      setNote(
        "That selection appears more than once or includes formatting. Select plain words, or pick a section.",
      );
      return null;
    }
    setNote(null);
    return sel === "none" ? (picked ? sectionRange(content, picked) : null) : sel;
  };
  return (
    <div
      role="group"
      className="shrink-0 border-b bg-muted/20 px-4 py-2"
      aria-label="Writing tools"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          aria-label="Section"
          className="h-7 min-w-0 flex-1 basis-[140px] rounded-md border border-input bg-background px-1.5 text-[11px]"
          value={section}
          onChange={(e) => {
            setSection(Number(e.target.value));
          }}
        >
          {sections.map((s, i) => (
            <option key={`${String(s.start)}-${s.title}`} value={i}>
              {s.title}
            </option>
          ))}
        </select>
        {ACTIONS.map((a) => (
          <Button
            key={a.id}
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            disabled={canvas.busy}
            onMouseDown={(e) => {
              e.preventDefault(); // keep the selection
            }}
            onClick={() => {
              const r = target();
              if (r) canvas.onAction(a.id, r);
            }}
          >
            {a.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          aria-label="Comment"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            const r = target();
            if (r) setCommenting({ range: r, body: "" });
          }}
        >
          <MessageSquare className="size-3.5" />
          Comment
        </Button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Acts on your selection, or on the chosen section. AI changes come back as a proposal to
        review.
      </p>
      {note && (
        <p role="status" className="mt-1 text-[11px] text-destructive">
          {note}
        </p>
      )}
      {commenting && (
        <form
          className="mt-2 flex flex-col gap-1.5"
          aria-label="New comment"
          onSubmit={(e) => {
            e.preventDefault();
            if (!commenting.body.trim()) return;
            canvas.onComment(commenting.range, commenting.body.trim());
            setCommenting(null);
          }}
        >
          <blockquote className="line-clamp-2 border-l-2 pl-2 text-[11px] text-muted-foreground">
            {commenting.range.quote}
          </blockquote>
          <div className="flex gap-2">
            <input
              aria-label="Comment text"
              autoFocus
              maxLength={8000}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
              value={commenting.body}
              onChange={(e) => {
                setCommenting({ ...commenting, body: e.target.value });
              }}
            />
            <Button type="submit" size="sm" disabled={!commenting.body.trim()}>
              Add
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setCommenting(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** AI proposals waiting for review: each is a diff against the version it started from. */
export function ProposalList({ canvas }: { canvas: CanvasProps }) {
  if (canvas.proposals.length === 0) return null;
  return (
    <section className="mb-4 flex flex-col gap-3" aria-label="Proposed changes">
      {canvas.proposals.map((p) => (
        <section
          key={p.id}
          className="rounded-lg border p-3"
          aria-label={`Proposal: ${p.instruction}`}
        >
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="w-full text-[12px] font-medium">{p.instruction}</span>
            {p.state === "pending" && (
              <Button
                size="sm"
                className="h-7 text-[11px]"
                disabled={p.stale}
                onClick={() => {
                  canvas.onAccept(p.id);
                }}
              >
                <Check className="size-3.5" />
                Accept as new version
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => {
                canvas.onDiscard(p.id);
              }}
            >
              <X className="size-3.5" />
              Discard
            </Button>
          </div>
          {p.state === "requested" && (
            <p className="text-[11px] text-muted-foreground">Writing a proposal…</p>
          )}
          {p.state === "interrupted" && (
            <p className="text-[11px] text-muted-foreground">
              The reply stopped before a full document came back. Nothing changed.
            </p>
          )}
          {p.stale && (
            <p role="status" className="mb-2 text-[11px] text-destructive">
              The document changed after this was proposed. Discard it, or ask again from the latest
              version.
            </p>
          )}
          {p.diff && <DiffView lines={p.diff} />}
        </section>
      ))}
    </section>
  );
}

/** Comments on the document, oldest first; resolved ones stay listed for the record. */
export function CommentList({ canvas }: { canvas: CanvasProps }) {
  if (canvas.comments.length === 0) return null;
  return (
    <section className="mt-6 border-t pt-3" aria-label="Comments">
      <h3 className="mb-2 text-[11px] font-medium text-muted-foreground">
        Comments ({canvas.comments.filter((c) => !c.resolved).length} open)
      </h3>
      <ul className="flex flex-col gap-2">
        {canvas.comments.map((c) => (
          <li
            key={c.id}
            className={`rounded-lg border px-3 py-2 text-[12px] ${c.resolved ? "opacity-60" : ""}`}
          >
            <blockquote className="mb-1 line-clamp-2 border-l-2 pl-2 text-[11px] text-muted-foreground">
              {c.quote}
            </blockquote>
            <p>{c.body}</p>
            {c.place !== "exact" && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {c.place === "review"
                  ? "The passage moved in a newer version."
                  : "The passage isn't in the latest version."}
              </p>
            )}
            <div className="mt-1 flex flex-wrap gap-1">
              {c.place === "review" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px]"
                  onClick={() => {
                    canvas.onReattach(c.id);
                  }}
                >
                  <RotateCcw className="size-3" />
                  Move to new position
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px]"
                onClick={() => {
                  canvas.onResolve(c.id, !c.resolved);
                }}
              >
                <Check className="size-3" />
                {c.resolved ? "Reopen" : "Resolve"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px]"
                aria-label="Delete comment"
                onClick={() => {
                  canvas.onDeleteComment(c.id);
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
