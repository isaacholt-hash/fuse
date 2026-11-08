import { Brain, ChevronRight, Square } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { money, number } from "./format";
import { Hint } from "./primitives";
import type { ReasoningView } from "./types";

/**
 * One line while and after a model thinks: title, reasoning tokens and cost (climbing while
 * live), and a chevron that opens the provider's summary where there is one.
 */
export function ReasoningLine({
  reasoning,
  onStop,
}: {
  reasoning: ReasoningView;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const r = reasoning;
  const tokens = r.tokens > 0 ? `${r.estimated ? "about " : ""}${number(r.tokens)} tokens` : null;
  const parts = [
    r.live ? "Thinking…" : `Thought for ${number(r.seconds)} s`,
    tokens,
    r.tokens > 0 ? money(r.costMicro) : null,
    r.live && r.seconds > 0 ? `${number(r.seconds)} s` : null,
  ].filter((p): p is string => p !== null);
  return (
    <div className="mb-3" role="group" aria-label="Reasoning">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded py-0.5 text-[12px] text-muted-foreground hover:text-foreground"
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          <Brain className={`size-3 ${r.live ? "animate-pulse" : ""}`} aria-hidden />
          <span>{parts.join(" · ")}</span>
          <ChevronRight
            className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
        </button>
        {r.live && onStop && (
          <Button variant="outline" size="sm" className="h-6 gap-1 text-[12px]" onClick={onStop}>
            <Square className="size-2.5" />
            Stop
            <Hint>Esc</Hint>
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-1.5 max-w-prose rounded-md border bg-muted/30 px-3 py-2 text-[12px] leading-5 text-muted-foreground whitespace-pre-wrap">
          {r.summary
            ? r.summary
            : r.live
              ? "The summary arrives as the model thinks, where the provider sends one."
              : "The provider doesn't show this model's reasoning; only its size and cost are known."}
        </div>
      )}
    </div>
  );
}
