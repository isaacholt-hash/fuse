import { useState } from "react";
import { diffLines } from "@/artifacts/diff";
import { Button } from "@/components/ui/button";
import { DiffView } from "./Artifacts";
import { Markdown } from "./Markdown";
import { Modal } from "./primitives";

export interface SideBySideAnswer {
  id: string;
  /** e.g. "Claude Sonnet 5.5" */
  model: string;
  /** e.g. "$0.0042" */
  cost: string;
  content: string;
  /** This is the answer the chat goes on from now. */
  current: boolean;
}

/**
 * Two or three answers to the same question side by side (CH-17), from compare mode (RT-12) or
 * regenerated branches. Two can show their differences; any can become the one the chat keeps.
 */
export function SideBySide({
  answers,
  onClose,
  onKeep,
}: {
  answers: SideBySideAnswer[];
  onClose: () => void;
  /** Goes on with this answer: it becomes the chat's current branch. */
  onKeep: (id: string) => void;
}) {
  const [diff, setDiff] = useState(false);
  const [a, b] = answers;
  return (
    <Modal
      open
      wide
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Answers side by side"
      description="The same question, answered by different models."
    >
      {a && b && answers.length === 2 && (
        <label className="mb-3 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={diff}
            onChange={(e) => {
              setDiff(e.target.checked);
            }}
          />
          Show differences
        </label>
      )}
      {diff && a && b ? (
        <DiffView lines={diffLines(a.content, b.content)} />
      ) : (
        <div className={`grid gap-3 ${answers.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
          {answers.map((ans) => (
            <section
              key={ans.id}
              aria-label={`Answer from ${ans.model}`}
              className="flex min-w-0 flex-col rounded-lg border"
            >
              <header className="flex items-center gap-2 border-b px-3 py-2 text-xs">
                <span className="flex-1 truncate font-medium">{ans.model}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{ans.cost}</span>
              </header>
              <div className="max-h-[55dvh] min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
                <Markdown content={ans.content} />
              </div>
              <footer className="border-t px-3 py-2">
                {ans.current ? (
                  <span className="text-[11px] text-muted-foreground">
                    The chat goes on from this one
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onKeep(ans.id);
                    }}
                  >
                    Go on with this one
                  </Button>
                )}
              </footer>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
