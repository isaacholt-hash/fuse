/**
 * M18.4 (SE-10, AG-04): one exportable activity log: tool calls, credential use, policy
 * changes, context-tool receipts and provider report runs. Redacted: secret-looking values
 * are replaced, long inputs and results are cut, and credentials, headers and provider replies
 * are never included (the tables don't hold them).
 */
import { findSecret, SECRET_LABELS } from "@/memory/secrets";
import { recentToolCalls } from "@/storage/runs";
import type { Tenant } from "@/storage/defaults";
import type { SqlDb } from "@/storage/sql";

export interface ActivityEntry {
  at: number;
  category: "tool" | "credential" | "policy" | "context" | "usage_report";
  /** Tool name, provider, setting scope or report provider. */
  subject: string;
  /** What happened: allowed/declined, request/set/remove, an outcome or a state. */
  action: string;
  /** Project and model for tool calls; scope for policy; empty otherwise. */
  where: string;
  /** Redacted inputs or a fixed message. */
  detail: string;
}

const MAX_VALUE = 200;
const MAX_ROWS = 5000;

/** A value as it may appear in an export: secrets named, never shown; long text cut. */
export function redactValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const kind = findSecret(text);
  if (kind) return `[removed: looked like ${SECRET_LABELS[kind]}]`;
  return text.length > MAX_VALUE
    ? `${text.slice(0, MAX_VALUE)}… (${String(text.length)} chars)`
    : text;
}

function redactInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}=${redactValue(v)}`)
    .join("; ");
}

export async function collectActivity(db: SqlDb, t: Tenant): Promise<ActivityEntry[]> {
  const entries: ActivityEntry[] = [];
  for (const c of await recentToolCalls(db, t, MAX_ROWS)) {
    const result = c.output.split("\n").find((l) => l.trim() !== "") ?? "";
    entries.push({
      at: c.at,
      category: "tool",
      subject: c.tool,
      action: `${c.approval ?? "not asked"}${c.isError ? ", failed" : ""}${c.flags.length ? `, flagged: ${c.flags.map((f) => f.why).join("; ")}` : ""}`,
      where: `${c.project} · ${c.model}`,
      detail: `${redactInput(c.input)}${result ? ` → ${redactValue(result)}` : ""}`,
    });
  }
  const audit = await db.select<{
    event_kind: "credential_use" | "policy_change";
    provider: string | null;
    scope_kind: string;
    scope_id: string | null;
    action: string;
    created_at: number;
  }>(
    `SELECT event_kind,provider,scope_kind,scope_id,action,created_at FROM security_audit
     WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?`,
    [t.workspaceId, MAX_ROWS],
  );
  for (const a of audit)
    entries.push({
      at: a.created_at,
      category: a.event_kind === "credential_use" ? "credential" : "policy",
      subject: a.provider ?? "",
      action: a.action,
      where: a.scope_id ? `${a.scope_kind} ${a.scope_id}` : a.scope_kind,
      detail: "",
    });
  const context = await db.select<{
    tool_name: string;
    record_kind: string;
    outcome: string;
    created_at: number;
  }>(
    `SELECT tool_name,record_kind,outcome,created_at FROM context_tool_audit
     WHERE workspace_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?`,
    [t.workspaceId, t.userId, MAX_ROWS],
  );
  for (const c of context)
    entries.push({
      at: c.created_at,
      category: "context",
      subject: c.tool_name,
      action: c.outcome,
      where: c.record_kind,
      detail: "",
    });
  const runs = await db.select<{
    provider: string;
    source: string;
    state: string;
    rows: number;
    message: string | null;
    created_at: number;
  }>(
    `SELECT provider,source,state,rows,message,created_at FROM usage_report_runs
     WHERE workspace_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?`,
    [t.workspaceId, t.userId, MAX_ROWS],
  );
  for (const r of runs)
    entries.push({
      at: r.created_at,
      category: "usage_report",
      subject: r.provider,
      action: r.state,
      where: r.source,
      detail: `${String(r.rows)} rows${r.message ? ` · ${r.message}` : ""}`,
    });
  return entries.sort((a, b) => b.at - a.at);
}

const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function activityCsv(entries: readonly ActivityEntry[]): string {
  const lines = ["when_utc,category,subject,action,where,detail"];
  for (const e of entries)
    lines.push(
      [new Date(e.at).toISOString(), e.category, e.subject, e.action, e.where, e.detail]
        .map(csvCell)
        .join(","),
    );
  return `${lines.join("\n")}\n`;
}

export function activityJson(entries: readonly ActivityEntry[]): string {
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      redacted: true,
      note: "Secret-looking values are removed and long values are cut. Credentials, headers and provider replies are never recorded.",
      entries: entries.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    },
    null,
    1,
  );
}
