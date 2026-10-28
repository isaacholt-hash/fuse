import { PiggyBank, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money } from "./format";

export interface BudgetView {
  id: string;
  /** "Everything" or the project's name. */
  scope: string;
  period: "day" | "month";
  limitMicro: number;
  spentMicro: number;
  hardStop: boolean;
  /** e.g. "Allowed until midnight" while a temporary raise is on. */
  allowed: string | null;
}

export interface BudgetForm {
  projectId: string | null;
  period: "day" | "month";
  /** US dollars, as typed. */
  limitUsd: number;
  hardStop: boolean;
}

/** Settings → Budgets (CO-03): limits per day or month, everywhere or per project. */
export function BudgetsSection({
  budgets,
  projects,
  onAdd,
  onDelete,
}: {
  budgets: BudgetView[];
  projects: { id: string; name: string }[];
  onAdd: (form: BudgetForm) => void;
  onDelete: (id: string) => void;
}) {
  const [projectId, setProjectId] = useState<string>("");
  const [period, setPeriod] = useState<"day" | "month">("month");
  const [limit, setLimit] = useState("");
  const [hardStop, setHardStop] = useState(false);
  const amount = Number(limit);
  const valid = limit.trim() !== "" && Number.isFinite(amount) && amount > 0;
  return (
    <section className="mt-8 border-t pt-6" aria-label="Budgets">
      <div className="mb-1 flex items-center gap-2">
        <PiggyBank className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Budgets</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Alerts at 50, 80 and 100%. From 80%, Auto answers one tier lower (never below the quality
        floor). At 100%, every message asks first, or is stopped if you choose a hard stop. A day
        that costs more than three times your recent average also gets an alert.
      </p>
      {budgets.length > 0 && (
        <ul className="mb-4 space-y-2">
          {budgets.map((b) => {
            const used = b.spentMicro / b.limitMicro;
            return (
              <li key={b.id} className="rounded-lg border px-3 py-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="flex-1">
                    <span className="font-medium">{b.scope}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {money(b.limitMicro)} a {b.period}
                      {b.hardStop ? " · hard stop" : ""}
                    </span>
                  </span>
                  <span className="font-mono text-[11px]">
                    {money(b.spentMicro)} ({Math.round(used * 100)}%)
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete the ${b.scope} budget`}
                    onClick={() => {
                      onDelete(b.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full ${used >= 1 ? "bg-destructive" : used >= 0.8 ? "bg-amber-500" : "bg-foreground/60"}`}
                    style={{ width: `${String(Math.min(100, used * 100))}%` }}
                  />
                </div>
                {b.allowed && <p className="mt-1 text-[10px] text-muted-foreground">{b.allowed}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label="New budget"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onAdd({ projectId: projectId || null, period, limitUsd: amount, hardStop });
          setLimit("");
          setHardStop(false);
        }}
      >
        <label className="text-[11px]">
          <span className="mb-1 block text-muted-foreground">For</span>
          <select
            aria-label="Budget for"
            className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
            }}
          >
            <option value="">Everything</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px]">
          <span className="mb-1 block text-muted-foreground">Per</span>
          <select
            aria-label="Budget period"
            className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value === "day" ? "day" : "month");
            }}
          >
            <option value="month">Month</option>
            <option value="day">Day</option>
          </select>
        </label>
        <label className="text-[11px]">
          <span className="mb-1 block text-muted-foreground">Limit ($)</span>
          <Input
            aria-label="Budget limit in dollars"
            inputMode="decimal"
            className="h-8 w-24 text-xs"
            value={limit}
            onChange={(e) => {
              setLimit(e.target.value);
            }}
          />
        </label>
        <label className="flex h-8 items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            checked={hardStop}
            onChange={(e) => {
              setHardStop(e.target.checked);
            }}
          />
          Hard stop
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={!valid}>
          Add budget
        </Button>
      </form>
    </section>
  );
}
