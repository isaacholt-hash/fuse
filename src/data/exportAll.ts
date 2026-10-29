/**
 * Export everything (SE-07): every table's rows as JSON, one Markdown file per chat, and the
 * attachment files, in one zip. API keys are never in the database (they live in the OS
 * keychain), so they can't end up here. Derived data (search index, vectors) is left out.
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import type { FilesApi } from "@/files/api";
import type { Tenant } from "@/storage/defaults";
import type { Message } from "@/storage/messages";
import { listMessages } from "@/storage/messages";
import type { SqlDb } from "@/storage/sql";
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
const safe = (title: string) =>
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

export interface ExportSummary {
  bytes: Uint8Array;
  chats: number;
  files: number;
}

export async function exportAll(
  db: SqlDb,
  tenant: Tenant,
  files: FilesApi,
  now = Date.now(),
): Promise<ExportSummary> {
  const tables: Record<string, unknown[]> = {};
  // Incognito chats are never kept, so they're never exported either.
  const incognito = `SELECT id FROM threads WHERE workspace_id = ? AND incognito = 1`;
  const where: Partial<Record<(typeof EXPORTED_TABLES)[number], string>> = {
    threads: "AND incognito = 0",
    messages: `AND thread_id NOT IN (${incognito})`,
  };
  for (const t of EXPORTED_TABLES) {
    const extra = where[t] ?? "";
    tables[t] = await db.select<Record<string, unknown>>(
      `SELECT * FROM ${t} WHERE workspace_id = ? ${extra}`,
      extra.includes("?") ? [tenant.workspaceId, tenant.workspaceId] : [tenant.workspaceId],
    );
  }
  const zip: Zippable = {
    "fuse-export.json": strToU8(
      JSON.stringify(
        {
          format: "fuse-export",
          version: 1,
          exportedAt: new Date(now).toISOString(),
          note: "Everything FUSE stores, table by table. API keys live in the OS keychain and are never included.",
          tables,
        },
        null,
        2,
      ),
    ),
  };

  const threads = await db.select<{
    id: string;
    title: string;
    created_at: number;
    active_leaf_id: string | null;
  }>(
    `SELECT id, title, created_at, active_leaf_id FROM threads
     WHERE workspace_id = ? AND deleted_at IS NULL AND incognito = 0 ORDER BY created_at`,
    [tenant.workspaceId],
  );
  const used = new Set<string>();
  for (const t of threads) {
    const path = buildPath(await listMessages(db, tenant, t.id), t.active_leaf_id);
    let name = `chats/${new Date(t.created_at).toISOString().slice(0, 10)} ${safe(t.title)}`;
    while (used.has(name)) name += " (2)";
    used.add(name);
    zip[`${name}.md`] = strToU8(chatMarkdown(t.title, t.created_at, path));
  }

  const stored = await db.select<{ sha256: string; name: string }>(
    `SELECT DISTINCT sha256, name FROM files WHERE workspace_id = ? AND deleted_at IS NULL`,
    [tenant.workspaceId],
  );
  let fileCount = 0;
  for (const f of stored) {
    try {
      zip[`files/${f.sha256}`] = await files.get(f.sha256);
      fileCount += 1;
    } catch {
      // A file missing on disk is left out; its row in files still says what it was.
    }
  }
  return { bytes: zipSync(zip, { level: 6 }), chats: threads.length, files: fileCount };
}
