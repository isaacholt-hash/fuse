import { FileBarChart, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ExportApi } from "@/artifacts/export";
import { Button } from "@/components/ui/button";
import type { ReportProvider, ReportsApi } from "@/reports/api";
import type { Tenant } from "@/storage/defaults";
import { getSetting, setSetting } from "@/storage/settings";
import type { SqlDb } from "@/storage/sql";
import {
  exportUsageCsv,
  importUsageCsv,
  latestRuns,
  type ReportRunView,
} from "@/storage/usageReports";

const PROVIDERS: { id: ReportProvider; name: string; key: string; where: string }[] = [
  {
    id: "openai",
    name: "OpenAI",
    key: "OpenAI admin key",
    where: "platform.openai.com → Settings → Organization → Admin keys (organization owners)",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    key: "Anthropic Admin API key",
    where: "platform.claude.com → Settings → Admin keys (organization admins)",
  },
];

const STATE: Record<ReportRunView["state"], string> = {
  running: "Collecting…",
  ok: "Collected",
  auth: "Key refused",
  rate_limited: "Rate limited",
  error: "Failed",
};

const when = (ms: number) =>
  new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * M18.3 (CO-06): provider usage and cost reports. Off until set up; a dedicated reporting key
 * per provider, never a chat key; only status is shown, never the key or the provider's reply.
 */
export function ProviderReports({
  db,
  tenant,
  api,
  exporter,
  webApp,
}: {
  db: SqlDb;
  tenant: Tenant;
  api?: ReportsApi;
  exporter?: ExportApi;
  webApp: boolean;
}) {
  const [saved, setSaved] = useState<Record<ReportProvider, boolean>>({
    openai: false,
    anthropic: false,
  });
  const [on, setOn] = useState<Record<ReportProvider, boolean>>({
    openai: false,
    anthropic: false,
  });
  const [collector, setCollector] = useState<"this" | "hulk">("this");
  const [runs, setRuns] = useState<ReportRunView[]>([]);
  const [draft, setDraft] = useState<Record<ReportProvider, string>>({ openai: "", anthropic: "" });
  const [scope, setScope] = useState<Record<ReportProvider, string>>({ openai: "", anthropic: "" });
  const [busy, setBusy] = useState<ReportProvider | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = async () => {
    const [o, a, c, r, so, sa] = await Promise.all([
      getSetting(db, tenant, "usage_report.openai"),
      getSetting(db, tenant, "usage_report.anthropic"),
      getSetting(db, tenant, "usage_report.collector"),
      latestRuns(db, tenant),
      getSetting(db, tenant, "usage_report.openai.scope"),
      getSetting(db, tenant, "usage_report.anthropic.scope"),
    ]);
    setScope({ openai: so ?? "", anthropic: sa ?? "" });
    setOn({ openai: o === "on", anthropic: a === "on" });
    setCollector(c === "hulk" ? "hulk" : "this");
    setRuns(r);
    if (api) {
      const [so, sa] = await Promise.all([api.keySaved("openai"), api.keySaved("anthropic")]);
      setSaved({ openai: so, anthropic: sa });
    }
  };
  useEffect(() => {
    Promise.resolve()
      .then(load)
      .catch((e: unknown) => {
        setNote(e instanceof Error ? e.message : String(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per database
  }, [db, tenant, api]);
  const act = (p: ReportProvider | null, job: () => Promise<unknown>, done?: string) => {
    setBusy(p);
    setNote(null);
    job()
      .then(() => {
        if (done) setNote(done);
        return load();
      })
      .catch((e: unknown) => {
        setNote(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setBusy(null);
      });
  };
  return (
    <section
      className="mt-8 flex flex-col gap-4 border-t pt-6 text-[13px]"
      aria-label="Provider usage reports"
      data-settings-control="provider-reports"
    >
      <div className="-mb-3 flex items-center gap-2">
        <FileBarChart className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Provider usage reports</h2>
      </div>
      <p className="text-[12px] leading-5 text-muted-foreground">
        Compare FUSE&apos;s own costs with what each provider reports. It&apos;s off until you add a
        reporting key here. Reporting keys are separate from chat keys, need organization admin
        access, stay in this {webApp ? "server's" : "computer's"} secret store and are only used to
        read usage and cost reports. Reports refresh every six hours and re-read the last seven UTC
        days. They never count as new spend.
      </p>
      {!api && (
        <p role="status" className="text-[12px] text-muted-foreground">
          Collecting reports isn&apos;t available here. CSV import still works.
        </p>
      )}
      {api &&
        PROVIDERS.map((p) => {
          const run = runs.find((r) => r.provider === p.id);
          return (
            <section key={p.id} aria-label={`${p.name} reports`} className="rounded-lg border p-3">
              <h4 className="mb-1 font-medium">{p.name}</h4>
              <p className="mb-2 text-[12px] text-muted-foreground">
                {saved[p.id]
                  ? "Reporting key saved."
                  : `No reporting key. Create one at ${p.where}.`}
              </p>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const key = draft[p.id];
                  setDraft((d) => ({ ...d, [p.id]: "" }));
                  act(p.id, () => api.saveKey(p.id, key), "Reporting key saved.");
                }}
              >
                <input
                  type="password"
                  autoComplete="off"
                  aria-label={p.key}
                  placeholder={saved[p.id] ? "Replace the reporting key" : p.key}
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                  value={draft[p.id]}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, [p.id]: e.target.value }));
                  }}
                />
                <Button type="submit" size="sm" disabled={!draft[p.id].trim() || busy !== null}>
                  Save
                </Button>
                {saved[p.id] && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      act(p.id, () => api.removeKey(p.id), "Reporting key removed.");
                    }}
                  >
                    Remove
                  </Button>
                )}
              </form>
              <label className="mt-2 flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={on[p.id]}
                  disabled={!saved[p.id]}
                  onChange={(e) => {
                    const v = e.target.checked;
                    act(null, () =>
                      setSetting(db, tenant, `usage_report.${p.id}`, v ? "on" : "off"),
                    );
                  }}
                />
                Collect {p.name} reports every six hours
              </label>
              <label className="mt-2 block text-[12px] text-muted-foreground">
                Compare only these {p.id === "openai" ? "projects" : "workspaces"} or key ids
                (comma-separated; empty compares everything):
                <input
                  aria-label={`${p.name} compared scopes`}
                  className="mt-1 block h-7 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={scope[p.id]}
                  onChange={(e) => {
                    setScope((s) => ({ ...s, [p.id]: e.target.value }));
                  }}
                  onBlur={(e) => {
                    const v = e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean)
                      .join(",");
                    act(null, () => setSetting(db, tenant, `usage_report.${p.id}.scope`, v));
                  }}
                />
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[12px]"
                  disabled={!saved[p.id] || busy !== null}
                  onClick={() => {
                    act(p.id, async () => {
                      const r = await api.refresh(p.id);
                      setNote(
                        `${p.name}: ${r.message}${r.state === "ok" ? ` ${String(r.rows)} rows.` : ""}`,
                      );
                    });
                  }}
                >
                  <RefreshCw className={`size-3 ${busy === p.id ? "animate-spin" : ""}`} />
                  Refresh now
                </Button>
                <span className="text-[12px] text-muted-foreground" role="status">
                  {run
                    ? `${STATE[run.state]} · ${when(run.at)} · ${String(run.rows)} rows${run.source === "csv" ? " (CSV)" : ""}${run.message && run.state !== "ok" ? ` · ${run.message}` : ""}`
                    : "Not collected yet."}
                </span>
              </div>
            </section>
          );
        })}
      {api && !webApp && (
        <fieldset className="flex flex-col gap-1 text-[12px]">
          <legend className="mb-1 font-medium">Who collects</legend>
          {(
            [
              ["this", "This computer, while FUSE is open"],
              ["hulk", "FUSE on HULK (set up its reporting keys there; this computer then skips)"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="report-collector"
                checked={collector === value}
                onChange={() => {
                  act(null, () => setSetting(db, tenant, "usage_report.collector", value));
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {exporter && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              act(null, async () => {
                const csv = await exportUsageCsv(db, tenant);
                const name = await exporter.save(
                  `fuse-usage-${new Date().toISOString().slice(0, 10)}.csv`,
                  new TextEncoder().encode(csv),
                );
                if (name) setNote(`Saved ${name}.`);
              });
            }}
          >
            Export usage CSV
          </Button>
        )}
        <label className="text-[12px] text-muted-foreground">
          Import report CSV:{" "}
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Import usage CSV"
            className="text-[12px]"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              act(null, async () => {
                const n = await importUsageCsv(db, tenant, await file.text());
                setNote(`Imported ${String(n)} report rows.`);
              });
            }}
          />
        </label>
      </div>
      {note && (
        <p role="status" className="text-[12px] text-muted-foreground">
          {note}
        </p>
      )}
    </section>
  );
}
