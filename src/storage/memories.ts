import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export type MemoryCategory = "preference" | "person" | "project" | "fact";
export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "fact",
  "preference",
  "person",
  "project",
];

/** A fact FUSE remembers (PM-02). Global unless `projectId` is set. */
export interface Memory {
  id: string;
  text: string;
  category: MemoryCategory;
  projectId: string | null;
  sourceThreadId: string | null;
  /** Title of the chat it came from, if that chat still exists. */
  sourceThreadTitle: string | null;
  /** 0–100: how sure the extracting model was; 100 for facts you typed yourself. */
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

interface MemoryRow {
  id: string;
  text: string;
  category: MemoryCategory;
  project_id: string | null;
  source_thread_id: string | null;
  thread_title: string | null;
  confidence: number;
  created_at: number;
  updated_at: number;
}

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  text: r.text,
  category: r.category,
  projectId: r.project_id,
  sourceThreadId: r.source_thread_id,
  sourceThreadTitle: r.thread_title,
  confidence: r.confidence,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SELECT_MEMORY = `
  SELECT m.id, m.text, m.category, m.project_id, m.source_thread_id, m.confidence, m.created_at,
         m.updated_at, t.title AS thread_title
  FROM memories m
  LEFT JOIN threads t ON t.id = m.source_thread_id AND t.deleted_at IS NULL`;
const ACTIVE = "m.deleted_at IS NULL AND m.superseded_by_id IS NULL";

/** Facts in use (not deleted, not replaced by a newer version), oldest first. */
export async function listMemories(db: SqlDb, tenant: Tenant): Promise<Memory[]> {
  const rows = await db.select<MemoryRow>(
    `${SELECT_MEMORY} WHERE m.workspace_id = ? AND ${ACTIVE} ORDER BY m.created_at, m.id`,
    [tenant.workspaceId],
  );
  return rows.map(toMemory);
}

export interface NewMemory {
  text: string;
  category: MemoryCategory;
  projectId?: string | null;
  sourceThreadId?: string | null;
  confidence?: number;
}

export const MAX_MEMORY_CHARS = 500;

function cleanText(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) throw new Error("A memory needs some text.");
  return t.slice(0, MAX_MEMORY_CHARS);
}

export async function addMemory(db: SqlDb, tenant: Tenant, m: NewMemory): Promise<string> {
  const now = Date.now();
  const id = uuidv7(now);
  const projectId = m.projectId ?? null;
  await db.execute(
    `INSERT INTO memories (id, workspace_id, user_id, text, category, scope, project_id,
       source_thread_id, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      cleanText(m.text),
      m.category,
      projectId ? "project" : "global",
      projectId,
      m.sourceThreadId ?? null,
      Math.round(Math.min(100, Math.max(0, m.confidence ?? 100))),
      now,
      now,
    ],
  );
  return id;
}

/** Your own edit: changes the fact in place (an approved update keeps history instead). */
export async function editMemory(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  change: { text: string; category: MemoryCategory; projectId: string | null },
): Promise<void> {
  await db.execute(
    `UPDATE memories SET text = ?, category = ?, scope = ?, project_id = ?, confidence = 100,
       updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      cleanText(change.text),
      change.category,
      change.projectId ? "project" : "global",
      change.projectId,
      Date.now(),
      tenant.workspaceId,
      id,
    ],
  );
}

export async function deleteMemory(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE memories SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [now, now, tenant.workspaceId, id],
  );
}

/** Wipe (PM-02): deletes every fact and drops every waiting suggestion. */
export async function deleteAllMemories(db: SqlDb, tenant: Tenant): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE memories SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND deleted_at IS NULL`,
    [now, now, tenant.workspaceId],
  );
  await db.execute(
    `UPDATE memory_proposals SET status = 'rejected', updated_at = ?
     WHERE workspace_id = ? AND status = 'pending'`,
    [now, tenant.workspaceId],
  );
}

// ---- Suggestions (PM-03) ----

export interface NewProposal {
  op: "add" | "update" | "delete";
  /** The fact to update or delete. */
  memoryId: string | null;
  text: string;
  category: MemoryCategory;
  projectId: string | null;
  confidence: number;
  /** The chat it came from; null for imported memories (PM-08). */
  sourceThreadId: string | null;
}

export interface Proposal extends NewProposal {
  id: string;
  /** Current text of the fact being updated or deleted. */
  currentText: string | null;
  sourceThreadTitle: string | null;
  createdAt: number;
}

export async function addProposals(
  db: SqlDb,
  tenant: Tenant,
  proposals: NewProposal[],
): Promise<void> {
  for (const p of proposals) {
    const now = Date.now();
    await db.execute(
      `INSERT INTO memory_proposals (id, workspace_id, user_id, op, memory_id, text, category,
         project_id, confidence, source_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(now),
        tenant.workspaceId,
        tenant.userId,
        p.op,
        p.op === "add" ? null : p.memoryId,
        p.text.trim().slice(0, MAX_MEMORY_CHARS),
        p.category,
        p.projectId,
        Math.round(Math.min(100, Math.max(0, p.confidence))),
        p.sourceThreadId,
        now,
        now,
      ],
    );
  }
}

interface ProposalRow {
  id: string;
  op: Proposal["op"];
  memory_id: string | null;
  text: string;
  category: MemoryCategory;
  project_id: string | null;
  confidence: number;
  source_thread_id: string;
  current_text: string | null;
  thread_title: string | null;
  created_at: number;
}

/** Suggestions waiting for a yes or no, oldest first. */
export async function listPendingProposals(db: SqlDb, tenant: Tenant): Promise<Proposal[]> {
  const rows = await db.select<ProposalRow>(
    `SELECT p.id, p.op, p.memory_id, p.text, p.category, p.project_id, p.confidence,
            p.source_thread_id, p.created_at, m.text AS current_text, t.title AS thread_title
     FROM memory_proposals p
     LEFT JOIN memories m ON m.id = p.memory_id
     LEFT JOIN threads t ON t.id = p.source_thread_id AND t.deleted_at IS NULL
     WHERE p.workspace_id = ? AND p.status = 'pending'
     ORDER BY p.created_at, p.id`,
    [tenant.workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    op: r.op,
    memoryId: r.memory_id,
    text: r.text,
    category: r.category,
    projectId: r.project_id,
    confidence: r.confidence,
    sourceThreadId: r.source_thread_id,
    currentText: r.current_text,
    sourceThreadTitle: r.thread_title,
    createdAt: r.created_at,
  }));
}

/** Text of suggestions already waiting or turned down, so they aren't suggested again. */
export async function proposalTexts(db: SqlDb, tenant: Tenant): Promise<string[]> {
  const rows = await db.select<{ text: string }>(
    `SELECT text FROM memory_proposals
     WHERE workspace_id = ? AND op != 'delete' AND status IN ('pending', 'rejected')`,
    [tenant.workspaceId],
  );
  return rows.map((r) => r.text);
}

/** Applies a suggestion, with your edits to its text if you made any. */
export async function approveProposal(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  editedText?: string,
): Promise<void> {
  const p = (await listPendingProposals(db, tenant)).find((x) => x.id === id);
  if (!p) return;
  const text = editedText?.trim() ? editedText : p.text;
  const target = p.memoryId
    ? (await listMemories(db, tenant)).find((m) => m.id === p.memoryId)
    : undefined;
  if (p.op === "add") {
    await addMemory(db, tenant, {
      text,
      category: p.category,
      projectId: p.projectId,
      sourceThreadId: p.sourceThreadId,
      confidence: p.confidence,
    });
  } else if (p.op === "update" && target) {
    const newId = await addMemory(db, tenant, {
      text,
      category: p.category,
      projectId: target.projectId,
      sourceThreadId: p.sourceThreadId,
      confidence: p.confidence,
    });
    await db.execute(
      `UPDATE memories SET superseded_by_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
      [newId, Date.now(), tenant.workspaceId, target.id],
    );
  } else if (p.op === "delete" && target) {
    await deleteMemory(db, tenant, target.id);
  }
  await setProposalStatus(db, tenant, id, "approved");
}

export async function rejectProposal(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  await setProposalStatus(db, tenant, id, "rejected");
}

async function setProposalStatus(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  status: "approved" | "rejected",
): Promise<void> {
  await db.execute(
    `UPDATE memory_proposals SET status = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
    [status, Date.now(), tenant.workspaceId, id],
  );
}

// ---- What was sent with each answer (PM-04) ----

export async function recordInjected(
  db: SqlDb,
  tenant: Tenant,
  messageId: string,
  memoryIds: string[],
): Promise<void> {
  const now = Date.now();
  for (const memoryId of memoryIds) {
    await db.execute(
      `INSERT OR IGNORE INTO message_memories (message_id, memory_id, workspace_id, user_id,
         created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [messageId, memoryId, tenant.workspaceId, tenant.userId, now],
    );
  }
}

/** The memories sent with each of these answers, by message id. */
export async function memoriesForMessages(
  db: SqlDb,
  tenant: Tenant,
  messageIds: string[],
): Promise<Map<string, { id: string; text: string }[]>> {
  const out = new Map<string, { id: string; text: string }[]>();
  if (messageIds.length === 0) return out;
  const rows = await db.select<{ message_id: string; id: string; text: string }>(
    `SELECT mm.message_id, m.id, m.text FROM message_memories mm
     JOIN memories m ON m.id = mm.memory_id
     WHERE mm.workspace_id = ? AND mm.message_id IN (${messageIds.map(() => "?").join(", ")})
     ORDER BY m.created_at, m.id`,
    [tenant.workspaceId, ...messageIds],
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({ id: r.id, text: r.text });
    out.set(r.message_id, list);
  }
  return out;
}
