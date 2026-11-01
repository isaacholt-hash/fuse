import { FileText, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RunChangeView } from "./types";

/**
 * M10 step 16 (CH-19): a session's files in one place, beside the conversation: every file its
 * runs changed (with Undo and Preview, as on the run cards) and every artifact it made.
 */
export function FilesPanel({
  changes,
  artifacts,
  busy,
  onUndo,
  onPreview,
  onOpenArtifact,
  onClose,
}: {
  changes: RunChangeView[];
  artifacts: { key: string; title: string }[];
  busy: boolean;
  onUndo?: (changeId: string) => void;
  onPreview?: (changeId: string) => void;
  onOpenArtifact: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Session files"
      className="flex w-[320px] shrink-0 flex-col border-l bg-background max-[800px]:hidden"
    >
      <div className="flex h-12 items-center justify-between border-b px-4">
        <h2 className="text-sm font-medium">Files</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Close files" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        <h3 className="mb-1.5 text-[10px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
          Changed
        </h3>
        {changes.length === 0 ? (
          <p className="mb-4 text-muted-foreground">No files changed yet.</p>
        ) : (
          <ul className="mb-4 space-y-1" aria-label="Changed files">
            {changes.map((c) => (
              <li
                key={c.id}
                className={`flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/50 ${c.undone ? "text-muted-foreground line-through" : ""}`}
              >
                <FileText className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={c.label}>
                  {c.label}
                </span>
                <span className="shrink-0 font-mono text-[10px]">
                  <span className="text-emerald-700 dark:text-emerald-400">+{String(c.added)}</span>{" "}
                  <span className="text-destructive">-{String(c.removed)}</span>
                </span>
                {!c.undone && c.previewable && onPreview && (
                  <button
                    type="button"
                    className="text-[10px] underline underline-offset-2"
                    aria-label={`Preview ${c.label}`}
                    onClick={() => {
                      onPreview(c.id);
                    }}
                  >
                    Preview
                  </button>
                )}
                {!c.undone && onUndo && (
                  <button
                    type="button"
                    className="text-[10px] underline underline-offset-2 disabled:opacity-50"
                    aria-label={`Undo ${c.label}`}
                    disabled={busy}
                    onClick={() => {
                      onUndo(c.id);
                    }}
                  >
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <h3 className="mb-1.5 text-[10px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
          Artifacts
        </h3>
        {artifacts.length === 0 ? (
          <p className="text-muted-foreground">None yet.</p>
        ) : (
          <ul className="space-y-1" aria-label="Artifacts">
            {artifacts.map((a) => (
              <li key={a.key}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted/50"
                  onClick={() => {
                    onOpenArtifact(a.key);
                  }}
                >
                  <Sparkles className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{a.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
