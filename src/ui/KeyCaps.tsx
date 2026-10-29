import { Gauge } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money } from "./format";

export interface KeyCapView {
  provider: "anthropic" | "openai";
  name: string;
  /** Dollars; null = no cap. */
  daily: number | null;
  monthly: number | null;
  spentToday: number;
  spentMonth: number;
  /** "day" or "month" when that cap is reached (and not raised for today). */
  stopped: "day" | "month" | null;
  raised: boolean;
}

/** Settings → Spend caps (MM-09): a hard daily and monthly limit per provider key. */
export function KeyCapsSection({
  caps,
  onSave,
  onRaise,
}: {
  caps: KeyCapView[];
  onSave: (provider: KeyCapView["provider"], daily: number | null, monthly: number | null) => void;
  onRaise: (provider: KeyCapView["provider"]) => void;
}) {
  return (
    <section className="mt-8 border-t pt-6" aria-label="Spend caps">
      <div className="mb-1 flex items-center gap-2">
        <Gauge className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Spend caps per key</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        A hard limit on what each key may spend, as a backstop to the limits in the providers&apos;
        consoles. Past it, FUSE makes no more calls on that key until the day or month ends; you can
        raise it for the rest of today.
      </p>
      {caps.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Add a key first.</p>
      ) : (
        <div className="space-y-3">
          {caps.map((c) => (
            <CapRow key={c.provider} cap={c} onSave={onSave} onRaise={onRaise} />
          ))}
        </div>
      )}
    </section>
  );
}

function CapRow({
  cap,
  onSave,
  onRaise,
}: {
  cap: KeyCapView;
  onSave: (provider: KeyCapView["provider"], daily: number | null, monthly: number | null) => void;
  onRaise: (provider: KeyCapView["provider"]) => void;
}) {
  const [daily, setDaily] = useState(cap.daily === null ? "" : String(cap.daily));
  const [monthly, setMonthly] = useState(cap.monthly === null ? "" : String(cap.monthly));
  const parse = (v: string) => (v.trim() === "" ? null : Number(v));
  const d = parse(daily);
  const m = parse(monthly);
  const valid = [d, m].every((x) => x === null || (Number.isFinite(x) && x > 0));
  return (
    <div className="rounded-lg border p-3 text-xs" aria-label={`${cap.name} cap`}>
      <p className="mb-2 font-medium">
        {cap.name}
        <span className="ml-2 font-normal text-muted-foreground">
          today {money(cap.spentToday)} · this month {money(cap.spentMonth)}
        </span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px]">
          Per day ($)
          <Input
            aria-label={`${cap.name} daily cap`}
            inputMode="decimal"
            className="h-8 w-24 text-xs"
            value={daily}
            onChange={(e) => {
              setDaily(e.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px]">
          Per month ($)
          <Input
            aria-label={`${cap.name} monthly cap`}
            inputMode="decimal"
            className="h-8 w-24 text-xs"
            value={monthly}
            onChange={(e) => {
              setMonthly(e.target.value);
            }}
          />
        </label>
        <Button
          size="sm"
          disabled={!valid}
          onClick={() => {
            onSave(cap.provider, d, m);
          }}
        >
          Save
        </Button>
      </div>
      {cap.stopped && (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-amber-700 dark:text-amber-400">
          Stopped: this {cap.stopped === "day" ? "day" : "month"}&apos;s cap is reached.
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onRaise(cap.provider);
            }}
          >
            Raise for today
          </Button>
        </p>
      )}
      {cap.raised && (
        <p className="mt-2 text-[11px] text-muted-foreground">Caps lifted for the rest of today.</p>
      )}
    </div>
  );
}
