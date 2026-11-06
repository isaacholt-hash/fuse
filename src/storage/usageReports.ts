/**
 * M18.3: provider usage/cost report rows (collected natively or imported from CSV) and the
 * usage CSV. Report rows are aggregates for reconciliation (M18.4); they never become
 * request_log spend.
 */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export interface ReportRunView {
  provider: "openai" | "anthropic";
  source: "api" | "csv";
  state: "running" | "ok" | "auth" | "rate_limited" | "error";
  rows: number;
  refreshedAt: number | null;
  message: string | null;
  at: number;
}

/** The newest run per provider, for the status-only settings view. */
export async function latestRuns(db: SqlDb, t: Tenant): Promise<ReportRunView[]> {
  const rows = await db.select<{
    provider: ReportRunView["provider"];
    source: ReportRunView["source"];
    state: ReportRunView["state"];
    rows: number;
    refreshed_at: number | null;
    message: string | null;
    updated_at: number;
  }>(
    `SELECT r.provider,r.source,r.state,r.rows,r.refreshed_at,r.message,r.updated_at
     FROM usage_report_runs r WHERE r.workspace_id=? AND r.user_id=? AND r.id=(
       SELECT id FROM usage_report_runs x WHERE x.workspace_id=r.workspace_id
         AND x.user_id=r.user_id AND x.provider=r.provider ORDER BY x.created_at DESC,x.id DESC LIMIT 1)
     ORDER BY r.provider`,
    [t.workspaceId, t.userId],
  );
  return rows.map((r) => ({
    provider: r.provider,
    source: r.source,
    state: r.state,
    rows: r.rows,
    refreshedAt: r.refreshed_at,
    message: r.message,
    at: r.updated_at,
  }));
}

// ---- CSV ----------------------------------------------------------------------------------

/** The columns FUSE writes and reads. One line per request (fuse) or report row (api, csv). */
export const CSV_COLUMNS = [
  "source",
  "date_utc",
  "provider",
  "kind",
  "scope",
  "key_id",
  "model",
  "line_item",
  "currency",
  "amount",
  "input_tokens",
  "output_tokens",
  "cached_tokens",
  "requests",
] as const;

const DAY = 86_400_000;
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function cell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  // Quote anything a spreadsheet could misread, and neutralize formula prefixes.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const microToAmount = (micro: number | null) => {
  if (micro === null) return "";
  const neg = micro < 0;
  const abs = Math.abs(micro);
  const s = `${String(Math.floor(abs / 1_000_000))}.${String(abs % 1_000_000).padStart(6, "0")}`;
  return neg ? `-${s}` : s;
};

/** Every FUSE request and every report row since `fromMs`, as CSV (UTF-8, header first). */
export async function exportUsageCsv(db: SqlDb, t: Tenant, fromMs = 0): Promise<string> {
  const requests = await db.select<{
    created_at: number;
    provider: string;
    model: string;
    project_id: string | null;
    cost_micro_usd: number;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
  }>(
    `SELECT created_at,provider,model,project_id,cost_micro_usd,input_tokens,output_tokens,
            cached_input_tokens FROM request_log WHERE workspace_id=? AND created_at>=?
     ORDER BY created_at,id`,
    [t.workspaceId, fromMs],
  );
  const reports = await db.select<{
    source: string;
    bucket_start: number;
    provider: string;
    kind: string;
    scope: string;
    key_ref: string;
    model: string;
    line_item: string;
    currency: string;
    amount_micro: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_tokens: number | null;
    requests: number | null;
  }>(
    `SELECT source,bucket_start,provider,kind,scope,key_ref,model,line_item,currency,
            amount_micro,input_tokens,output_tokens,cached_tokens,requests
     FROM usage_report_rows WHERE workspace_id=? AND user_id=? AND bucket_start>=?
     ORDER BY bucket_start,provider,kind,scope,model,line_item`,
    [t.workspaceId, t.userId, fromMs],
  );
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of requests)
    lines.push(
      [
        "fuse",
        dateOf(r.created_at),
        r.provider,
        "request",
        r.project_id ?? "",
        "",
        r.model,
        "",
        "usd",
        microToAmount(r.cost_micro_usd),
        r.input_tokens,
        r.output_tokens,
        r.cached_input_tokens,
        1,
      ]
        .map(cell)
        .join(","),
    );
  for (const r of reports)
    lines.push(
      [
        r.source,
        dateOf(r.bucket_start),
        r.provider,
        r.kind,
        r.scope,
        r.key_ref,
        r.model,
        r.line_item,
        r.currency,
        microToAmount(r.amount_micro),
        r.input_tokens,
        r.output_tokens,
        r.cached_tokens,
        r.requests,
      ]
        .map(cell)
        .join(","),
    );
  return `${lines.join("\n")}\n`;
}

/** RFC 4180 fields, with quotes and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("The CSV has an unclosed quote.");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Exact decimal dollars to micro-dollars ("1.5" → 1500000); null when not a plain number. */
export function amountToMicro(text: string): number | null {
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,12}))?$/.exec(text.trim());
  if (!m) return null;
  const frac = (m[3] ?? "").padEnd(7, "0");
  const micro =
    Number(m[2]) * 1_000_000 + Number(frac.slice(0, 6)) + (Number(frac[6]) >= 5 ? 1 : 0);
  return m[1] ? -micro : micro;
}

const intOrNull = (s: string | undefined) => {
  if (s === undefined || s.trim() === "") return null;
  if (!/^\d{1,15}$/.test(s.trim())) throw new Error(`"${s}" isn't a whole number.`);
  return Number(s.trim());
};

/**
 * Imports report rows from a CSV in FUSE's format (the fallback without admin access). Rows
 * with source "fuse" are skipped: they're FUSE's own requests. Imported rows are source "csv";
 * re-importing the same day and scope replaces it. Returns how many rows were stored.
 */
export async function importUsageCsv(db: SqlDb, t: Tenant, text: string): Promise<number> {
  const [header, ...body] = parseCsv(text.startsWith("\uFEFF") ? text.slice(1) : text);
  if (!header) throw new Error("The CSV is empty.");
  const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  for (const need of ["date_utc", "provider", "kind", "amount"] as const)
    if (!col.has(need))
      throw new Error(`The CSV needs a "${need}" column (FUSE's usage CSV format).`);
  const get = (r: string[], name: string) => {
    const i = col.get(name);
    return i === undefined ? "" : (r[i] ?? "").trim();
  };
  const now = Date.now();
  const statements = [];
  let line = 1;
  for (const r of body) {
    line++;
    if (get(r, "source") === "fuse") continue;
    const date = get(r, "date_utc");
    const start = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    const provider = get(r, "provider");
    const kind = get(r, "kind");
    const amount = get(r, "amount");
    const micro = amount === "" ? null : amountToMicro(amount);
    if (
      Number.isNaN(start) ||
      !["openai", "anthropic"].includes(provider) ||
      !["cost", "usage"].includes(kind) ||
      (amount !== "" && micro === null)
    )
      throw new Error(`Line ${String(line)} isn't a valid usage row. Nothing was imported.`);
    let tokens: (number | null)[];
    try {
      tokens = ["input_tokens", "output_tokens", "cached_tokens", "requests"].map((n) =>
        intOrNull(get(r, n)),
      );
    } catch (e) {
      throw new Error(
        `Line ${String(line)}: ${e instanceof Error ? e.message : String(e)} Nothing was imported.`,
        { cause: e },
      );
    }
    statements.push({
      sql: `INSERT INTO usage_report_rows(id,workspace_id,user_id,provider,kind,source,bucket_start,
              bucket_end,scope,key_ref,model,line_item,currency,amount_micro,input_tokens,
              output_tokens,cached_tokens,requests,run_id,created_at,updated_at)
            VALUES (?,?,?,?,?,'csv',?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)
            ON CONFLICT(workspace_id,user_id,provider,kind,source,bucket_start,scope,key_ref,model,line_item)
            DO UPDATE SET currency=excluded.currency,amount_micro=excluded.amount_micro,
              input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
              cached_tokens=excluded.cached_tokens,requests=excluded.requests,updated_at=excluded.updated_at`,
      params: [
        uuidv7(now),
        t.workspaceId,
        t.userId,
        provider,
        kind,
        start,
        start + DAY,
        get(r, "scope"),
        get(r, "key_id"),
        get(r, "model"),
        get(r, "line_item"),
        (get(r, "currency") || "usd").toLowerCase(),
        micro,
        ...tokens,
        now,
        now,
      ],
    });
  }
  if (statements.length > 0) {
    statements.push({
      sql: `INSERT INTO usage_report_runs(id,workspace_id,user_id,provider,source,state,window_start,
              window_end,rows,message,created_at,updated_at)
            SELECT ?||'-'||provider,?,?,provider,'csv','ok',MIN(bucket_start),MAX(bucket_end),COUNT(*),
              'Imported from CSV.',?,? FROM usage_report_rows
            WHERE workspace_id=? AND user_id=? AND source='csv' AND updated_at=? GROUP BY provider`,
      params: [uuidv7(now + 1), t.workspaceId, t.userId, now, now, t.workspaceId, t.userId, now],
    });
    await db.batch(statements);
  }
  return statements.length === 0 ? 0 : statements.length - 1;
}
