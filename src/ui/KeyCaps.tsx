import type { ProviderId } from "@/catalog/catalog";
import { Gauge } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Money } from "./primitives";
import { DEFAULT_RUN_CAP_MICRO_USD, isUncapped, NO_RUN_CAP_MICRO_USD } from "@/agent/runCap";

/**
 * Settings → Cost cap per run (AG-05): the cap new Code and Work runs start with, or none. A
 * session or project can still set its own; runs warn at 80% of their cap.
 */
export function RunCapSection({
  capMicroUsd,
  onCap,
}: {
  capMicroUsd: number;
  onCap: (capMicroUsd: number) => void;
}) {
  const off = isUncapped(capMicroUsd);
  const [value, setValue] = useState(
    ((off ? DEFAULT_RUN_CAP_MICRO_USD : capMicroUsd) / 1_000_000).toFixed(2),
  );
  const n = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(n) && n > 0;
  const micro = valid ? Math.round(n * 1_000_000) : null;
  return (
    <section aria-label="Run cost cap">
      <div className="mb-1 flex items-center gap-2">
        <Gauge className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Cost cap per run</h2>
      </div>
      <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
        Code and Work runs pause at this cap and ask before spending more. A run warns you at 80% of
        it, with a button to remove it. Sessions and projects can set their own.
      </p>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label="Pause runs at a cost cap"
            checked={!off}
            onChange={(e) => {
              onCap(e.target.checked ? (micro ?? DEFAULT_RUN_CAP_MICRO_USD) : NO_RUN_CAP_MICRO_USD);
            }}
          />
          Pause runs at
        </label>
        <label className="flex items-center gap-1">
          $
          <Input
            aria-label="Cost cap per run"
            inputMode="decimal"
            className="h-8 w-24 text-xs"
            disabled={off}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </label>
        <Button
          size="sm"
          disabled={off || micro === null || micro === capMicroUsd}
          onClick={() => {
            if (micro !== null) onCap(micro);
          }}
        >
          Save
        </Button>
        <span className="text-[12px] text-muted-foreground">
          {off ? "Off: runs don't stop on cost." : null}
        </span>
      </div>
    </section>
  );
}

export interface KeyCapView {
  provider: ProviderId;
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
      <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
        A hard limit on what each key may spend, as a backstop to the limits in the providers&apos;
        consoles. Past it, FUSE makes no more calls on that key until the day or month ends; you can
        raise it for the rest of today.
      </p>
      {caps.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">Add a key first.</p>
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
          today <Money micro={cap.spentToday} /> · this month <Money micro={cap.spentMonth} />
        </span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px]">
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
        <label className="flex flex-col gap-1 text-[12px]">
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
        {(cap.daily !== null || cap.monthly !== null) && (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Turn off ${cap.name} caps`}
            onClick={() => {
              setDaily("");
              setMonthly("");
              onSave(cap.provider, null, null);
            }}
          >
            Turn off
          </Button>
        )}
      </div>
      {cap.stopped && (
        <p className="mt-2 flex items-center gap-2 text-[12px] text-warning">
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
        <p className="mt-2 text-[12px] text-muted-foreground">Caps lifted for the rest of today.</p>
      )}
    </div>
  );
}
