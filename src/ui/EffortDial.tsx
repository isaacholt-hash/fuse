import { Check } from "lucide-react";
import type { EffortLevel } from "@/catalog/catalog";
import { EFFORT_LABELS } from "@/routing/effort";
import { money } from "./format";

/** What the composer knows about effort for the next message (M10 step 22, RT-08). */
export interface EffortView {
  /** What routing (or your defaults) would use when you don't choose. */
  auto: EffortLevel;
  /** The levels the model that would answer offers. */
  options: readonly EffortLevel[];
  /** What a level adds to this message, over `auto`, in micro-dollars (negative: saves). */
  extraMicro: (level: EffortLevel) => number;
}

const signed = (micro: number) =>
  micro === 0 ? "" : micro > 0 ? `+${money(micro)}` : `−${money(-micro)}`;

/**
 * The effort for this one message, inside the model menu (M10 step 26; a dial of its own in
 * step 22). Unset, it's the level routing picked; each other level shows what it adds. Reasoning
 * tokens stay priced separately in the answer's cost breakdown.
 */
export function EffortOptions({
  effort,
  value,
  onChange,
}: {
  effort: EffortView;
  value: EffortLevel | null;
  onChange: (level: EffortLevel | null) => void;
}) {
  const current = value ?? effort.auto;
  return (
    <div role="group" aria-label="Reasoning effort" className="border-t px-4 py-2.5">
      <p className="mb-1.5 text-[12px] text-muted-foreground">
        Effort for this message. The usual is {EFFORT_LABELS[effort.auto]}.
      </p>
      <div className="flex flex-wrap gap-1">
        {[null, ...effort.options].map((level) => {
          const on = level === null ? value === null : value === level;
          const delta = level === null ? 0 : effort.extraMicro(level);
          return (
            <button
              key={level ?? "auto"}
              type="button"
              role="radio"
              aria-checked={on}
              className={`flex items-center gap-1 rounded-[4px] border px-2 py-1 text-[12px] outline-offset-[-2px] hover:bg-accent focus-visible:bg-accent ${on ? "border-foreground/40 bg-accent font-medium" : "text-muted-foreground"}`}
              onClick={() => {
                onChange(level);
              }}
            >
              {on && <Check className="size-3" aria-hidden />}
              {level === null ? "Usual" : EFFORT_LABELS[level]}
              {level !== null && level !== current && delta !== 0 && (
                <span className="tabular-nums text-[12px] text-muted-foreground">
                  {signed(delta)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
