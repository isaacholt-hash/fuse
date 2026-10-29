/**
 * Restore from a FUSE export (PL-12): everything in it, or one project. Exports are untrusted
 * input, so the zip is checked before anything is written: size limits, known file names only,
 * rows of plain values for known tables, and every file's bytes against the SHA-256 that names
 * it. Records keep their ids; ones already here are skipped, never overwritten. A link to a
 * record that isn't here (a global memory left out of a project export, say) is cleared, and set
 * again once its target arrives. Format: docs/export-format.md.
 */
import { strFromU8, unzipSync } from "fflate";
import type { FilesApi } from "@/files/api";
import type { Tenant } from "@/storage/defaults";
import type { SqlDb, SqlValue } from "@/storage/sql";
import { DELETE_ORDER } from "./deleteAll";
import { EXPORT_FORMAT, EXPORTED_TABLES } from "./exportAll";

/** Limits for an export read into memory. */
export const RESTORE_LIMITS = {
  /** The zip itself. */
  zipBytes: 1024 * 1024 * 1024,
  /** All entries unpacked (guards against zip bombs). */
  unpackedBytes: 2 * 1024 * 1024 * 1024,
  /** One entry unpacked; attachments are capped at 50 MB when stored. */
  entryBytes: 256 * 1024 * 1024,
  entries: 200_000,
};

type Table = (typeof EXPORTED_TABLES)[number];
type Row = Record<string, SqlValue>;

export interface ParsedExport {
  version: number;
  exportedAt: string | null;
  scope: { kind: "all" } | { kind: "project"; projectId: string; name: string };
  records: Partial<Record<Table, Row[]>>;
  /** File bytes by SHA-256, each checked against its name. */
  files: Map<string, Uint8Array>;
  /** Projects in the export, for choosing one. */
  projects: { id: string; name: string }[];
}

export class RestoreError extends Error {}

const TABLES = new Set<string>(EXPORTED_TABLES);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rows must be objects of plain values (text, numbers, null); anything else is refused. */
function readRows(table: string, raw: unknown): Row[] {
  if (!Array.isArray(raw)) throw new RestoreError(`${table} isn't a list of records.`);
  return raw.map((r: unknown) => {
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      throw new RestoreError(`${table} has a record that isn't an object.`);
    }
    const row: Row = {};
    for (const [k, v] of Object.entries(r) as [string, unknown][]) {
      if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new RestoreError(`${table} has a bad column name.`);
      if (v !== null && typeof v !== "string" && typeof v !== "number") {
        throw new RestoreError(`${table}.${k} holds something that isn't text or a number.`);
      }
      row[k] = v;
    }
    return row;
  });
}

const json = (bytes: Uint8Array | undefined, what: string): unknown => {
  if (!bytes) throw new RestoreError(`The export has no ${what}.`);
  try {
    return JSON.parse(strFromU8(bytes)) as unknown;
  } catch {
    throw new RestoreError(`${what} isn't valid JSON.`);
  }
};

/** Reads and checks an export (version 1 or 2) without writing anything. */
export async function readFuseExport(zipBytes: Uint8Array): Promise<ParsedExport> {
  if (zipBytes.length > RESTORE_LIMITS.zipBytes) throw new RestoreError("The export is too large.");
  let total = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes, {
      filter: (f) => {
        count += 1;
        total += f.originalSize;
        if (
          count > RESTORE_LIMITS.entries ||
          total > RESTORE_LIMITS.unpackedBytes ||
          f.originalSize > RESTORE_LIMITS.entryBytes
        ) {
          throw new RestoreError("The export unpacks to more than FUSE will read.");
        }
        // Only the parts FUSE restores; chats/*.md and anything else are skipped.
        return (
          f.name === "manifest.json" ||
          f.name === "fuse-export.json" ||
          /^records\/[a-z_]+\.json$/.test(f.name) ||
          /^files\/[0-9a-f]{64}$/.test(f.name)
        );
      },
    });
  } catch (e) {
    if (e instanceof RestoreError) throw e;
    throw new RestoreError("That isn't a zip FUSE can read.");
  }

  const records: Partial<Record<Table, Row[]>> = {};
  let version: number;
  let exportedAt: string | null;
  let scope: ParsedExport["scope"] = { kind: "all" };
  if (entries["manifest.json"]) {
    const m = json(entries["manifest.json"], "manifest.json") as Record<string, unknown>;
    if (m.format !== EXPORT_FORMAT || typeof m.version !== "number") {
      throw new RestoreError("That zip isn't a FUSE export.");
    }
    version = m.version;
    if (version !== 2) throw new RestoreError(`Export version ${String(version)} isn't supported.`);
    exportedAt = typeof m.exportedAt === "string" ? m.exportedAt : null;
    const s = m.scope as Record<string, unknown> | undefined;
    if (s?.kind === "project" && typeof s.projectId === "string") {
      scope = {
        kind: "project",
        projectId: s.projectId,
        name: typeof s.name === "string" ? s.name : "",
      };
    }
    for (const [name, bytes] of Object.entries(entries)) {
      const table = /^records\/([a-z_]+)\.json$/.exec(name)?.[1];
      if (table && TABLES.has(table)) records[table as Table] = readRows(table, json(bytes, name));
    }
  } else {
    // Version 1: one file with every table.
    const v1 = json(entries["fuse-export.json"], "manifest") as Record<string, unknown>;
    if (v1.format !== EXPORT_FORMAT || v1.version !== 1) {
      throw new RestoreError("That zip isn't a FUSE export.");
    }
    version = 1;
    exportedAt = typeof v1.exportedAt === "string" ? v1.exportedAt : null;
    const tables = v1.tables as Record<string, unknown> | undefined;
    for (const [table, rows] of Object.entries(tables ?? {})) {
      if (TABLES.has(table)) records[table as Table] = readRows(table, rows);
    }
  }

  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(entries)) {
    const sha = /^files\/([0-9a-f]{64})$/.exec(name)?.[1];
    if (!sha) continue;
    if ((await sha256(bytes)) !== sha) {
      throw new RestoreError(`A file in the export doesn't match its name (${sha.slice(0, 12)}…).`);
    }
    files.set(sha, bytes);
  }
  const projects = (records.projects ?? []).flatMap((p) =>
    typeof p.id === "string" && p.deleted_at == null
      ? [{ id: p.id, name: String(p.name ?? "") }]
      : [],
  );
  return { version, exportedAt, scope, records, files, projects };
}

const str = (v: SqlValue | undefined) => (typeof v === "string" ? v : null);

/** Keeps only one project's rows, the way a project export picks them. */
export function onlyProject(parsed: ParsedExport, projectId: string): ParsedExport {
  const r = parsed.records;
  const threads = new Set(
    (r.threads ?? [])
      .filter((t) => t.project_id === projectId && t.incognito !== 1)
      .map((t) => str(t.id)),
  );
  const messages = new Set(
    (r.messages ?? []).filter((m) => threads.has(str(m.thread_id))).map((m) => str(m.id)),
  );
  const fileIds = new Set([
    ...(r.project_files ?? []).filter((p) => p.project_id === projectId).map((p) => str(p.file_id)),
    ...(r.message_files ?? [])
      .filter((f) => messages.has(str(f.message_id)))
      .map((f) => str(f.file_id)),
    ...(r.files ?? []).filter((f) => threads.has(str(f.thread_id))).map((f) => str(f.id)),
  ]);
  const artifacts = new Set(
    (r.artifacts ?? []).filter((a) => threads.has(str(a.thread_id))).map((a) => str(a.id)),
  );
  const budgets = new Set(
    (r.budgets ?? []).filter((b) => b.project_id === projectId).map((b) => str(b.id)),
  );
  const inProject = (row: Row) => row.project_id === projectId;
  const keep: Record<Table, (row: Row) => boolean> = {
    projects: (p) => p.id === projectId,
    threads: (t) => threads.has(str(t.id)),
    messages: (m) => messages.has(str(m.id)),
    message_citations: (c) => messages.has(str(c.message_id)),
    message_files: (f) => messages.has(str(f.message_id)),
    message_memories: (m) => messages.has(str(m.message_id)),
    files: (f) => fileIds.has(str(f.id)),
    project_files: inProject,
    thread_summaries: (s) => threads.has(str(s.thread_id)),
    memories: (m) => inProject(m) || threads.has(str(m.thread_id)),
    memory_proposals: (p) => inProject(p) || threads.has(str(p.source_thread_id)),
    artifacts: (a) => artifacts.has(str(a.id)),
    artifact_versions: (v) => artifacts.has(str(v.artifact_id)),
    budgets: (b) => budgets.has(str(b.id)),
    budget_events: (e) => budgets.has(str(e.budget_id)),
    web_pages: (w) => fileIds.has(str(w.file_id)),
    imports: (i) => threads.has(str(i.thread_id)),
    thread_tags: (t) => threads.has(str(t.thread_id)),
    prompts: inProject,
    egress_rules: inProject,
    request_log: (l) => threads.has(str(l.thread_id)),
    user_instructions: () => false,
    golden_prompts: () => false,
  };
  const records: Partial<Record<Table, Row[]>> = {};
  for (const t of EXPORTED_TABLES) records[t] = (r[t] ?? []).filter(keep[t]);
  const shas = new Set((records.files ?? []).map((f) => str(f.sha256)));
  const name = parsed.projects.find((p) => p.id === projectId)?.name ?? "";
  return {
    ...parsed,
    scope: { kind: "project", projectId, name },
    records,
    files: new Map([...parsed.files].filter(([sha]) => shas.has(sha))),
  };
}

/** Parents before children: the reverse of the order delete-all uses. */
const INSERT_ORDER = [...DELETE_ORDER].reverse().filter((t): t is Table => TABLES.has(t));

interface ForeignKey {
  from: string;
  table: string;
  to: string;
  required: boolean;
}

interface TableShape {
  columns: Set<string>;
  keys: ForeignKey[];
  /** Primary key columns, to tell what's already here. */
  primary: string[];
}

async function shapeOf(db: SqlDb, table: string): Promise<TableShape> {
  const cols = await db.select<{ name: string; notnull: number; pk: number }>(
    `PRAGMA table_info(${table})`,
  );
  const fks = await db.select<{ from: string; table: string; to: string | null }>(
    `PRAGMA foreign_key_list(${table})`,
  );
  const notNull = new Set(cols.filter((c) => c.notnull === 1).map((c) => c.name));
  return {
    columns: new Set(cols.map((c) => c.name)),
    primary: cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name),
    keys: fks
      // The tenant columns are set to this workspace and user on the way in.
      .filter((f) => f.from !== "workspace_id" && f.from !== "user_id")
      .map((f) => ({
        from: f.from,
        table: f.table,
        to: f.to ?? "id",
        required: notNull.has(f.from),
      })),
  };
}

const exists = async (db: SqlDb, table: string, column: string, value: SqlValue) =>
  (await db.select(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`, [value])).length > 0;

export interface RestoreCount {
  table: Table;
  /** Rows in the export (after choosing a project). */
  rows: number;
  /** Already here: skipped. */
  existing: number;
}

const LABELS: Partial<Record<Table, string>> = {
  projects: "Projects",
  threads: "Chats",
  messages: "Messages",
  memories: "Memories, decisions and tasks",
  files: "Files",
  artifacts: "Artifacts",
  prompts: "Saved prompts",
};

/** The plan as lines for the preview: the main kinds of record, the rest together. */
export function restoreLines(
  plan: readonly RestoreCount[],
): { label: string; rows: number; existing: number }[] {
  const out = new Map<string, { label: string; rows: number; existing: number }>();
  for (const c of plan) {
    const label = LABELS[c.table] ?? "Other records";
    const line = out.get(label) ?? { label, rows: 0, existing: 0 };
    line.rows += c.rows;
    line.existing += c.existing;
    out.set(label, line);
  }
  return [...out.values()].sort(
    (a, b) => (a.label === "Other records" ? 1 : 0) - (b.label === "Other records" ? 1 : 0),
  );
}

/** What a restore would do, without doing it. */
export async function planRestore(db: SqlDb, parsed: ParsedExport): Promise<RestoreCount[]> {
  const out: RestoreCount[] = [];
  for (const table of INSERT_ORDER) {
    const rows = parsed.records[table] ?? [];
    if (rows.length === 0) continue;
    const { primary } = await shapeOf(db, table);
    let existing = 0;
    for (const row of rows) {
      const where = primary.map((c) => `${c} = ?`).join(" AND ");
      if (
        primary.length > 0 &&
        (
          await db.select(
            `SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`,
            primary.map((c) => row[c] ?? null),
          )
        ).length > 0
      ) {
        existing += 1;
      }
    }
    out.push({ table, rows: rows.length, existing });
  }
  return out;
}

export interface RestoreResult {
  added: number;
  /** Already here, or pointing at something required that isn't. */
  skipped: number;
  files: number;
}

/** Writes the export's records and files into this workspace. */
export async function applyRestore(
  db: SqlDb,
  tenant: Tenant,
  parsed: ParsedExport,
  files: FilesApi,
): Promise<RestoreResult> {
  let added = 0;
  let skipped = 0;
  // Links cleared because their target wasn't here yet: set again at the end.
  const pending: { table: Table; primary: string[]; row: Row; key: ForeignKey }[] = [];
  for (const table of INSERT_ORDER) {
    const rows = parsed.records[table] ?? [];
    if (rows.length === 0) continue;
    const shape = await shapeOf(db, table);
    for (const original of rows) {
      const row: Row = {};
      for (const [k, v] of Object.entries(original)) if (shape.columns.has(k)) row[k] = v;
      row.workspace_id = tenant.workspaceId;
      row.user_id = tenant.userId;
      let usable = true;
      for (const key of shape.keys) {
        const value = row[key.from];
        if (value === null || value === undefined) continue;
        // A row pointing at itself or a later row in the same table is linked afterwards.
        if (await exists(db, key.table, key.to, value)) continue;
        if (key.required && key.table !== table) {
          usable = false;
          break;
        }
        row[key.from] = null;
        pending.push({ table, primary: shape.primary, row: original, key });
      }
      if (!usable) {
        skipped += 1;
        continue;
      }
      const cols = Object.keys(row);
      try {
        const { rowsAffected } = await db.execute(
          `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          cols.map((c) => row[c] ?? null),
        );
        if (rowsAffected > 0) added += 1;
        else skipped += 1;
      } catch {
        // A row this database's rules refuse (e.g. a project memory whose project isn't here).
        skipped += 1;
      }
    }
  }
  for (const { table, primary, row, key } of pending) {
    const value = row[key.from] ?? null;
    if (primary.length === 0 || !(await exists(db, key.table, key.to, value))) continue;
    await db.execute(
      `UPDATE ${table} SET ${key.from} = ? WHERE ${primary.map((c) => `${c} = ?`).join(" AND ")}
         AND ${key.from} IS NULL`,
      [value, ...primary.map((c) => row[c] ?? null)],
    );
  }
  let stored = 0;
  for (const [sha, bytes] of parsed.files) {
    const put = await files.put(bytes);
    if (put.sha256 !== sha) throw new RestoreError("A restored file didn't store as itself.");
    stored += 1;
  }
  return { added, skipped, files: stored };
}
