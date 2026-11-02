import { Brain, Check } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { EffortLevel } from "@/catalog/catalog";
import { EFFORT_LABELS } from "@/routing/effort";
import { money } from "./format";
import { Tip } from "./primitives";

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
 * The effort dial beside "Auto → model": the level for this one message. Unset, it shows what
 * routing picked; a choice shows its label and what it adds. Reasoning tokens stay priced
 * separately in the answer's cost breakdown.
 */
export function EffortDial({
  effort,
  value,
  onChange,
  menu = false,
}: {
  effort: EffortView;
  value: EffortLevel | null;
  onChange: (level: EffortLevel | null) => void;
  /** Inside the composer's "More" menu: full width, label always shown. */
  menu?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = value ?? effort.auto;
  const extra = value ? effort.extraMicro(value) : 0;
  const label = value
    ? `${EFFORT_LABELS[value]}${extra ? ` ${signed(extra)}` : ""}`
    : EFFORT_LABELS[effort.auto];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip
        label={
          value
            ? `Reasoning effort for this message: ${EFFORT_LABELS[value]}${extra ? ` (${signed(extra)} on the usual)` : ""}`
            : `Reasoning effort: ${EFFORT_LABELS[effort.auto]}, set by routing. Click to change it for this message.`
        }
      >
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Reasoning effort"
            aria-pressed={value !== null}
            className={`shrink-0 gap-1.5 text-xs ${menu ? "justify-start" : ""} ${value ? "bg-accent text-foreground" : "text-muted-foreground"}`}
          >
            <Brain className="size-3.5" />
            <span className={menu ? "" : "hidden min-[900px]:inline"}>{label}</span>
          </Button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-40 w-60 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
          aria-label="Reasoning effort"
        >
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            How hard the model thinks on this message. The usual is {EFFORT_LABELS[effort.auto]}.
          </p>
          {[null, ...effort.options].map((level) => {
            const on = level === null ? value === null : value === level;
            const delta = level === null ? 0 : effort.extraMicro(level);
            return (
              <button
                key={level ?? "auto"}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => {
                  onChange(level);
                  setOpen(false);
                }}
              >
                <Check className={`size-3 ${on ? "" : "invisible"}`} aria-hidden />
                <span className="flex-1">
                  {level === null ? `Usual (${EFFORT_LABELS[effort.auto]})` : EFFORT_LABELS[level]}
                </span>
                {level !== null && level !== current && delta !== 0 && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {signed(delta)}
                  </span>
                )}
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
