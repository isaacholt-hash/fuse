/**
 * Export everything, or one project (SE-07, PL-12): every table's rows as JSON, one Markdown file
 * per chat, and the attachment files, in one zip in a documented format (docs/export-format.md)
 * that FUSE restores and another program can read. API keys are never in the database (they
 * live in the OS keychain), so they can't end up here. Derived data (search index, vectors) is
 * left out.
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import type { FilesApi } from "@/files/api";
import type { Tenant } from "@/storage/defaults";
import type { Message } from "@/storage/messages";
import { listMessages } from "@/storage/messages";
import type { SqlDb, SqlValue } from "@/storage/sql";
import { buildPath } from "@/storage/tree";

/** Tables in the export, in an order that reads well. */
export const EXPORTED_TABLES = [
  "threads",
  "messages",
  "message_citations",
  "message_files",
  "files",
  "thread_summaries",
  "projects",
  "project_files",
  "memories",
  "memory_proposals",
  "message_memories",
  "artifacts",
  "artifact_versions",
  "user_instructions",
  "budgets",
  "budget_events",
  "golden_prompts",
  "web_pages",
  "imports",
  "thread_tags",
  "prompts",
  "egress_rules",
  "request_log",
] as const;

/** A title as a file name: no path separators or characters Windows refuses, no control codes. */
export const exportName = (title: string) =>
  title
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/[\s\S]/g, (c) => (c.charCodeAt(0) < 32 ? "-" : c))
    .trim()
    .slice(0, 80) || "chat";

/** One chat as Markdown: the branch on screen, oldest first. */
export function chatMarkdown(title: string, createdAt: number, path: readonly Message[]): string {
  const lines = [
    `# ${title}`,
    "",
    `_Started ${new Date(createdAt).toISOString().slice(0, 10)}_`,
    "",
  ];
  for (const m of path) {
    if (m.role === "user") lines.push("## You", "", m.content, "");
    else if (m.role === "assistant") {
      lines.push(`## ${m.model ?? "Assistant"}`, "", m.content, "");
    }
  }
  return lines.join("\n");
}

/** The documented export format (`docs/export-format.md`). Version 1 was one JSON file. */
export const EXPORT_FORMAT = "fuse-export";
export const EXPORT_VERSION = 2;

/** Everything, or one project with its chats and what they point at (PL-12). */
export type ExportScope = { kind: "all" } | { kind: "project"; projectId: string };

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  scope: { kind: "all" } | { kind: "project"; projectId: string; name: string };
  /** The last database migration applied when it was made; null when unknown. */
  schema: number | null;
  /** Rows in `records/<table>.json`, by table. */
  tables: Record<string, number>;
  /** Every file in `files/`, named by its SHA-256. */
  files: { sha256: string; bytes: number }[];
  note: string;
}

export interface ExportSummary {
  bytes: Uint8Array;
  chats: number;
  files: number;
}

type Filter = { sql: string; params: SqlValue[] };

/**
 * Which rows of each table belong to one project: the project, its non-incognito chats and their
 * messages, and the files, memories, artifacts, prompts, budgets and rules tied to them. A row
 * pointing at something outside the export (a global memory, say) is handled on restore.
 */
function projectFilters(
  ws: string,
  projectId: string,
): Partial<Record<(typeof EXPORTED_TABLES)[number], Filter>> {
  const threads = {
    sql: "SELECT id FROM threads WHERE workspace_id = ? AND project_id = ? AND incognito = 0",
    params: [ws, projectId],
  };
  const messages = {
    sql: `SELECT id FROM messages WHERE thread_id IN (${threads.sql})`,
    params: threads.params,
  };
  const inThreads = (col: string): Filter => ({
    sql: `AND ${col} IN (${threads.sql})`,
    params: threads.params,
  });
  const inMessages = (col: string): Filter => ({
    sql: `AND ${col} IN (${messages.sql})`,
    params: messages.params,
  });
  const fileIds = {
    sql: `SELECT file_id FROM project_files WHERE workspace_id = ? AND project_id = ?
          UNION SELECT file_id FROM message_files WHERE message_id IN (${messages.sql})`,
    params: [ws, projectId, ...messages.params],
  };
  return {
    projects: { sql: "AND id = ?", params: [projectId] },
    threads: { sql: "AND project_id = ? AND incognito = 0", params: [projectId] },
    messages: inThreads("thread_id"),
    message_citations: inMessages("message_id"),
    message_files: inMessages("message_id"),
    message_memories: inMessages("message_id"),
    files: {
      sql: `AND (id IN (${fileIds.sql}) OR thread_id IN (${threads.sql}))`,
      params: [...fileIds.params, ...threads.params],
    },
    project_files: { sql: "AND project_id = ?", params: [projectId] },
    thread_summaries: inThreads("thread_id"),
    memories: {
      sql: `AND (project_id = ? OR thread_id IN (${threads.sql}))`,
      params: [projectId, ...threads.params],
    },
    memory_proposals: {
      sql: `AND (project_id = ? OR source_thread_id IN (${threads.sql}))`,
      params: [projectId, ...threads.params],
    },
    artifacts: inThreads("thread_id"),
    artifact_versions: {
      sql: `AND artifact_id IN (SELECT id FROM artifacts WHERE thread_id IN (${threads.sql}))`,
      params: threads.params,
    },
    budgets: { sql: "AND project_id = ?", params: [projectId] },
    budget_events: {
      sql: "AND budget_id IN (SELECT id FROM budgets WHERE project_id = ?)",
      params: [projectId],
    },
    web_pages: { sql: `AND file_id IN (${fileIds.sql})`, params: fileIds.params },
    imports: inThreads("thread_id"),
    thread_tags: inThreads("thread_id"),
    prompts: { sql: "AND project_id = ?", params: [projectId] },
    egress_rules: { sql: "AND project_id = ?", params: [projectId] },
    request_log: inThreads("thread_id"),
    // Global records only: not part of a project.
    user_instructions: { sql: "AND 0", params: [] },
    golden_prompts: { sql: "AND 0", params: [] },
  };
}

/** The last migration applied, from sqlx's own table (absent in the test database). */
async function schemaVersion(db: SqlDb): Promise<number | null> {
  try {
    const [row] = await db.select<{ v: number | null }>(
      "SELECT MAX(version) AS v FROM _sqlx_migrations",
    );
    return row?.v ?? null;
  } catch {
    return null;
  }
}

/** Everything FUSE stores: the whole workspace. */
export const exportAll = (db: SqlDb, tenant: Tenant, files: FilesApi, now = Date.now()) =>
  exportData(db, tenant, files, { kind: "all" }, now);

/**
 * An export in the documented format (PL-12): `manifest.json`, `records/<table>.json` (rows as
 * stored), `files/<sha256>`, and a readable Markdown copy of each chat under `chats/`.
 */
export async function exportData(
  db: SqlDb,
  tenant: Tenant,
  files: FilesApi,
  scope: ExportScope,
  now = Date.now(),
): Promise<ExportSummary> {
  const ws = tenant.workspaceId;
  const project =
    scope.kind === "project"
      ? (
          await db.select<{ name: string }>(
            "SELECT name FROM projects WHERE workspace_id = ? AND id = ?",
            [ws, scope.projectId],
          )
        )[0]
      : undefined;
  if (scope.kind === "project" && !project) throw new Error("That project doesn't exist.");
  const filters = scope.kind === "project" ? projectFilters(ws, scope.projectId) : {};
  // Incognito chats are never kept, so they're never exported either.
  const incognito = `SELECT id FROM threads WHERE workspace_id = ? AND incognito = 1`;
  const always: Partial<Record<(typeof EXPORTED_TABLES)[number], Filter>> = {
    threads: { sql: "AND incognito = 0", params: [] },
    messages: { sql: `AND thread_id NOT IN (${incognito})`, params: [ws] },
  };
  const zip: Zippable = {};
  const counts: Record<string, number> = {};
  for (const t of EXPORTED_TABLES) {
    const parts = [always[t], filters[t]].filter((f): f is Filter => f !== undefined);
    const rows = await db.select<Record<string, unknown>>(
      `SELECT * FROM ${t} WHERE workspace_id = ? ${parts.map((p) => p.sql).join(" ")}`,
      [ws, ...parts.flatMap((p) => p.params)],
    );
    counts[t] = rows.length;
    zip[`records/${t}.json`] = strToU8(JSON.stringify(rows, null, 1));
  }

  const threadRows = await db.select<{
    id: string;
    title: string;
    created_at: number;
    active_leaf_id: string | null;
  }>(
    `SELECT id, title, created_at, active_leaf_id FROM threads
     WHERE workspace_id = ? AND deleted_at IS NULL AND incognito = 0
       ${scope.kind === "project" ? "AND project_id = ?" : ""}
     ORDER BY created_at`,
    scope.kind === "project" ? [ws, scope.projectId] : [ws],
  );
  const used = new Set<string>();
  for (const t of threadRows) {
    const path = buildPath(await listMessages(db, tenant, t.id), t.active_leaf_id);
    let name = `chats/${new Date(t.created_at).toISOString().slice(0, 10)} ${exportName(t.title)}`;
    while (used.has(name)) name += " (2)";
    used.add(name);
    zip[`${name}.md`] = strToU8(chatMarkdown(t.title, t.created_at, path));
  }

  const fileFilter = filters.files;
  const stored = await db.select<{ sha256: string }>(
    `SELECT DISTINCT sha256 FROM files WHERE workspace_id = ? AND deleted_at IS NULL
     ${fileFilter?.sql ?? ""}`,
    [ws, ...(fileFilter?.params ?? [])],
  );
  const manifestFiles: ExportManifest["files"] = [];
  for (const f of stored) {
    try {
      const bytes = await files.get(f.sha256);
      zip[`files/${f.sha256}`] = bytes;
      manifestFiles.push({ sha256: f.sha256, bytes: bytes.length });
    } catch {
      // A file missing on disk is left out; its row in files still says what it was.
    }
  }

  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    scope:
      scope.kind === "project"
        ? { kind: "project", projectId: scope.projectId, name: project?.name ?? "" }
        : { kind: "all" },
    schema: await schemaVersion(db),
    tables: counts,
    files: manifestFiles,
    note: "Made by FUSE. The format is described in docs/export-format.md. API keys live in the OS keychain and are never included; search indexes are rebuilt, not exported.",
  };
  zip["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  return {
    bytes: zipSync(zip, { level: 6 }),
    chats: threadRows.length,
    files: manifestFiles.length,
  };
}
