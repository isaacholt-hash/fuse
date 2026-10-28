import { ArrowLeft, BarChart3, PiggyBank, TrendingDown, TrendingUp } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money, number } from "./format";

export type UsagePeriod = "day" | "week" | "month";

export interface UsageRowView {
  label: string;
  micro: number;
  calls: number;
}

export interface UsageScreenView {
  period: UsagePeriod;
  /** Integer micro-dollars. */
  total: number;
  previous: number;
  calls: number;
  bars: { label: string; micro: number }[];
  sections: { title: string; rows: UsageRowView[] }[];
}

/** This month's savings (CO-04), all in micro-dollars. */
export interface SavingsView {
  /** e.g. "October" */
  month: string;
  spent: number;
  onBest: number;
  cache: number;
  subscription: number | null;
}

/** Spent against Best, against your subscriptions, and what caching saved. */
function SavingsCard({
  savings,
  onSubscription,
}: {
  savings: SavingsView;
  onSubscription: (usd: number | null) => void;
}) {
  const [draft, setDraft] = useState(
    savings.subscription === null ? "" : String(savings.subscription / 1_000_000),
  );
  const row = (label: string, value: string, note?: string) => (
    <div className="flex items-baseline justify-between gap-3 border-t py-2 first:border-t-0">
      <span>
        {label}
        {note && <span className="block text-[10px] text-muted-foreground">{note}</span>}
      </span>
      <span className="font-mono">{value}</span>
    </div>
  );
  const vsBest = savings.onBest - savings.spent;
  const vsSubs = savings.subscription === null ? null : savings.subscription - savings.spent;
  return (
    <section className="mt-6 rounded-xl border p-5 text-xs" aria-label="Savings">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <PiggyBank className="size-4 text-muted-foreground" />
        Savings in {savings.month}
      </h2>
      {row("Spent", money(savings.spent))}
      {row(
        "The same answers on Best",
        money(savings.onBest),
        vsBest > 0
          ? `Routing saved ${money(vsBest)} (an estimate: other models use other token counts)`
          : undefined,
      )}
      {row(
        "Prompt caching saved",
        money(savings.cache),
        "Cheaper cached reads, minus what writing the cache cost",
      )}
      <div className="flex items-baseline justify-between gap-3 border-t py-2">
        <label htmlFor="subscription" className="flex-1">
          Your subscriptions (a month)
          <span className="block text-[10px] text-muted-foreground">
            {vsSubs === null
              ? "What you paid for ChatGPT, Claude and the like"
              : vsSubs >= 0
                ? `${money(vsSubs)} less than your subscriptions so far`
                : `${money(-vsSubs)} more than your subscriptions so far`}
          </span>
        </label>
        <Input
          id="subscription"
          aria-label="Subscriptions per month in dollars"
          inputMode="decimal"
          className="h-7 w-20 text-right font-mono text-xs"
          value={draft}
          placeholder="$"
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onBlur={() => {
            const n = Number(draft);
            onSubscription(draft.trim() === "" ? null : Number.isFinite(n) && n >= 0 ? n : null);
          }}
        />
      </div>
    </section>
  );
}

const PERIODS: { id: UsagePeriod; label: string; previous: string }[] = [
  { id: "day", label: "Today", previous: "yesterday" },
  { id: "week", label: "7 days", previous: "the 7 days before" },
  { id: "month", label: "30 days", previous: "the 30 days before" },
];

/** Spend by period and where it went (CO-02). Costs come from the request log. */
export function UsageScreen({
  view,
  savings = null,
  onPeriod,
  onSubscription,
  onBack,
}: {
  view: UsageScreenView | null;
  savings?: SavingsView | null;
  onPeriod: (period: UsagePeriod) => void;
  onSubscription?: (usd: number | null) => void;
  onBack: () => void;
}) {
  const period = PERIODS.find((p) => p.id === view?.period) ?? PERIODS[1];
  const change =
    view && view.previous > 0
      ? Math.round(((view.total - view.previous) / view.previous) * 100)
      : null;
  const top = Math.max(1, ...(view?.bars.map((b) => b.micro) ?? []));
  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <header className="flex h-[66px] items-center border-b px-6">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          Back to conversation
        </Button>
      </header>
      <div className="mx-auto max-w-[760px] px-8 py-9">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-medium tracking-[0.15em] text-muted-foreground uppercase">
              <BarChart3 className="size-3" />
              Usage
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">Where the money went</h1>
          </div>
          <div className="flex rounded-lg border p-0.5" role="tablist" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={view?.period === p.id}
                className={`rounded-md px-3 py-1 text-xs ${view?.period === p.id ? "bg-accent font-medium" : "text-muted-foreground"}`}
                onClick={() => {
                  onPeriod(p.id);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {!view ? (
          <p className="mt-10 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <section className="mt-8 rounded-xl border p-5" aria-label="Total">
              <p className="text-[11px] text-muted-foreground">Spent · {period?.label}</p>
              <p className="mt-1 font-mono text-3xl font-semibold tracking-tight">
                {money(view.total)}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {change === null ? (
                  `${money(view.previous)} ${period?.previous ?? ""}`
                ) : (
                  <>
                    {change > 0 ? (
                      <TrendingUp className="size-3" />
                    ) : (
                      <TrendingDown className="size-3" />
                    )}
                    {change > 0 ? "+" : ""}
                    {change}% against {period?.previous} ({money(view.previous)})
                  </>
                )}
                <span className="mx-1 opacity-40">·</span>
                {number(view.calls)} provider calls
              </p>
              <div
                className="mt-5 flex h-24 items-end gap-[2px]"
                role="img"
                aria-label="Spend over the period"
              >
                {view.bars.map((b, i) => (
                  <div
                    key={i}
                    title={`${b.label}: ${money(b.micro)}`}
                    className="flex-1 rounded-t-sm bg-foreground/70"
                    style={{
                      height: `${String(b.micro > 0 ? Math.max(3, (b.micro / top) * 100) : 0)}%`,
                    }}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-foreground">
                <span>{view.bars[0]?.label}</span>
                <span>{view.bars.at(-1)?.label}</span>
              </div>
            </section>
            {savings && onSubscription && (
              <SavingsCard savings={savings} onSubscription={onSubscription} />
            )}
            <div className="mt-6 grid grid-cols-2 gap-4 max-[800px]:grid-cols-1">
              {view.sections.map((s) => (
                <section
                  key={s.title}
                  className="rounded-xl border p-4"
                  aria-label={`By ${s.title}`}
                >
                  <h2 className="mb-3 text-xs font-medium">By {s.title}</h2>
                  {s.rows.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">Nothing yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {s.rows.map((r) => (
                        <li key={r.label} className="text-[11px]">
                          <div className="flex justify-between gap-3">
                            <span className="truncate">{r.label}</span>
                            <span className="font-mono">{money(r.micro)}</span>
                          </div>
                          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full bg-foreground/60"
                              style={{
                                width: `${String(view.total > 0 ? (r.micro / view.total) * 100 : 0)}%`,
                              }}
                            />
                          </div>
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            {number(r.calls)} call{r.calls === 1 ? "" : "s"}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
