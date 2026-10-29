import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import { getSetting, setSetting } from "./settings";
import type { SqlDb } from "./sql";

/**
 * What sort of record a memory is (PM-12). Provider-neutral: adapters translate these into
 * whatever a provider expects; a provider's message format is never what is stored.
 */
export type MemoryKind =
  "fact" | "preference" | "person" | "constraint" | "decision" | "task" | "source";
export const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "preference",
  "person",
  "constraint",
  "decision",
  "task",
  "source",
];
/** Kinds a model may suggest after a chat. Decisions are only ever added by you (PM-15). */
export const SUGGESTED_KINDS: readonly MemoryKind[] = [
  "fact",
  "preference",
  "person",
  "constraint",
];

/** Where a memory applies (PM-13). */
export type MemoryScope = "global" | "workspace" | "project" | "conversation";
/** Who said so (PM-14), strongest first: yours outrank imported, which outrank extracted. */
export type MemoryAuthority = "you" | "imported" | "extracted";
export type MemoryStatus = "active" | "excluded" | "superseded" | "expired" | "deleted";

/** A record FUSE remembers (PM-02, PM-12 to PM-14). */
export interface Memory {
  id: string;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  projectId: string | null;
  /** The chat a conversation-scoped memory belongs to. */
  threadId: string | null;
  authority: MemoryAuthority;
  status: MemoryStatus;
  sourceThreadId: string | null;
  /** Title of the chat it came from, if that chat still exists. */
  sourceThreadTitle: string | null;
  /** 'typed', 'chat' or 'import'. */
  extractionMethod: string;
  extractionModel: string | null;
  /** 0–100: how sure the extracting model was; 100 for facts you typed yourself. */
  confidence: number;
  sensitivity: "normal" | "sensitive";
  /** False: never sent to a provider (SE-13). */
  maySend: boolean;
  expiresAt: number | null;
  lastVerifiedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

interface MemoryRow {
  id: string;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  project_id: string | null;
  thread_id: string | null;
  authority: MemoryAuthority;
  status: MemoryStatus;
  source_thread_id: string | null;
  thread_title: string | null;
  extraction_method: string;
  extraction_model: string | null;
  confidence: number;
  sensitivity: "normal" | "sensitive";
  may_send: number;
  expires_at: number | null;
  last_verified_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  text: r.text,
  kind: r.kind,
  scope: r.scope,
  projectId: r.project_id,
  threadId: r.thread_id,
  authority: r.authority,
  status: r.status,
  sourceThreadId: r.source_thread_id,
  sourceThreadTitle: r.thread_title,
  extractionMethod: r.extraction_method,
  extractionModel: r.extraction_model,
  confidence: r.confidence,
  sensitivity: r.sensitivity,
  maySend: r.may_send === 1,
  expiresAt: r.expires_at,
  lastVerifiedAt: r.last_verified_at,
  revision: r.revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SELECT_MEMORY = `
  SELECT m.id, m.text, m.kind, m.scope, m.project_id, m.thread_id, m.authority, m.status,
         m.source_thread_id, m.extraction_method, m.extraction_model, m.confidence,
         m.sensitivity, m.may_send, m.expires_at, m.last_verified_at, m.revision, m.created_at,
         m.updated_at, t.title AS thread_title
  FROM memories m
  LEFT JOIN threads t ON t.id = m.source_thread_id AND t.deleted_at IS NULL`;
/** In use: active and not past its expiry. */
const ACTIVE =
  "m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)";

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
  kind: MemoryKind;
  projectId?: string | null;
  /** Set for a memory that only applies in one chat (conversation scope). */
  threadId?: string | null;
  sourceThreadId?: string | null;
  confidence?: number;
  /** Default: you typed it. */
  authority?: MemoryAuthority;
  extractionMethod?: "typed" | "chat" | "import";
  extractionModel?: string | null;
}

const DEVICE_KEY = "device.id";

/** This install's id, made once; every change records it so sync (PL-04) can tell devices apart. */
export async function deviceId(db: SqlDb, tenant: Tenant): Promise<string> {
  const known = await getSetting(db, tenant, DEVICE_KEY);
  if (known) return known;
  const id = uuidv7();
  await setSetting(db, tenant, DEVICE_KEY, id);
  return id;
}

const scopeOf = (projectId: string | null, threadId: string | null): MemoryScope =>
  threadId ? "conversation" : projectId ? "project" : "global";

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
  const threadId = m.threadId ?? null;
  await db.execute(
    `INSERT INTO memories (id, workspace_id, user_id, text, kind, scope, project_id, thread_id,
       authority, source_thread_id, extraction_method, extraction_model, confidence, task_status,
       device_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      cleanText(m.text),
      m.kind,
      scopeOf(projectId, threadId),
      projectId,
      threadId,
      m.authority ?? "you",
      m.sourceThreadId ?? null,
      m.extractionMethod ?? "typed",
      m.extractionModel ?? null,
      Math.round(Math.min(100, Math.max(0, m.confidence ?? 100))),
      m.kind === "task" ? "open" : null,
      await deviceId(db, tenant),
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
  change: { text: string; kind: MemoryKind; projectId: string | null },
): Promise<void> {
  // Your edit makes the record yours (PM-15's authority order).
  await db.execute(
    `UPDATE memories SET text = ?, kind = ?,
       scope = CASE WHEN scope = 'conversation' THEN scope WHEN ? IS NULL THEN 'global' ELSE 'project' END,
       project_id = ?, confidence = 100, authority = 'you',
       task_status = CASE WHEN ? = 'task' THEN COALESCE(task_status, 'open') END,
       revision = revision + 1, device_id = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      cleanText(change.text),
      change.kind,
      change.projectId,
      change.projectId,
      change.kind,
      await deviceId(db, tenant),
      Date.now(),
      tenant.workspaceId,
      id,
    ],
  );
}

export async function deleteMemory(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE memories SET status = 'deleted', deleted_at = ?, revision = revision + 1, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [now, now, tenant.workspaceId, id],
  );
}

/** Wipe (PM-02): deletes every fact and drops every waiting suggestion. */
export async function deleteAllMemories(db: SqlDb, tenant: Tenant): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE memories SET status = 'deleted', deleted_at = ?, revision = revision + 1, updated_at = ?
     WHERE workspace_id = ? AND status != 'deleted'`,
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
  kind: MemoryKind;
  projectId: string | null;
  confidence: number;
  /** The chat it came from; null for imported memories (PM-08). */
  sourceThreadId: string | null;
  /** The model that suggested it, when one did. */
  extractionModel?: string | null;
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
      `INSERT INTO memory_proposals (id, workspace_id, user_id, op, memory_id, text, kind,
         project_id, confidence, source_thread_id, origin, extraction_model, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(now),
        tenant.workspaceId,
        tenant.userId,
        p.op,
        p.op === "add" ? null : p.memoryId,
        p.text.trim().slice(0, MAX_MEMORY_CHARS),
        p.kind,
        p.projectId,
        Math.round(Math.min(100, Math.max(0, p.confidence))),
        p.sourceThreadId,
        p.sourceThreadId ? "chat" : "import",
        p.extractionModel ?? null,
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
  kind: MemoryKind;
  project_id: string | null;
  confidence: number;
  source_thread_id: string;
  extraction_model: string | null;
  current_text: string | null;
  thread_title: string | null;
  created_at: number;
}

/** Suggestions waiting for a yes or no, oldest first. */
export async function listPendingProposals(db: SqlDb, tenant: Tenant): Promise<Proposal[]> {
  const rows = await db.select<ProposalRow>(
    `SELECT p.id, p.op, p.memory_id, p.text, p.kind, p.project_id, p.confidence,
            p.source_thread_id, p.extraction_model, p.created_at, m.text AS current_text,
            t.title AS thread_title
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
    kind: r.kind,
    projectId: r.project_id,
    confidence: r.confidence,
    sourceThreadId: r.source_thread_id,
    extractionModel: r.extraction_model,
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
/** Words that say little about what a fact is about. */
const STOP_WORDS = new Set(
  "a an the and or but of in on at to for with by from is are was were be been has have had do does did i my me you your he she they we it its this that their our as not no".split(
    " ",
  ),
);
const keyWords = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w && !STOP_WORDS.has(w)),
  );

/**
 * PM-11: the saved fact a new one may contradict: the same kind of fact, about the same thing
 * (at least half of the shorter one's key words shared), but not the same words.
 */
export function conflictWith(
  memories: readonly Memory[],
  text: string,
  kind: MemoryKind,
): Memory | null {
  const words = keyWords(text);
  let best: { m: Memory; share: number } | null = null;
  for (const m of memories) {
    if (m.kind !== kind) continue;
    const other = keyWords(m.text);
    const shared = [...words].filter((w) => other.has(w)).length;
    const shorter = Math.min(words.size, other.size);
    if (shorter === 0 || (shared === words.size && shared === other.size)) continue;
    const share = shared / shorter;
    if (share >= 0.5 && (!best || share > best.share)) best = { m, share };
  }
  return best?.m ?? null;
}

/**
 * Accepts a suggestion. `replaceId` (PM-11) makes a new fact replace a saved one it
 * contradicts: the old one is kept as history, not overwritten.
 */
export async function approveProposal(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  editedText?: string,
  replaceId?: string,
): Promise<void> {
  const found = (await listPendingProposals(db, tenant)).find((x) => x.id === id);
  if (!found) return;
  const p: Proposal =
    replaceId && found.op === "add" ? { ...found, op: "update", memoryId: replaceId } : found;
  const text = editedText?.trim() ? editedText : p.text;
  const target = p.memoryId
    ? (await listMemories(db, tenant)).find((m) => m.id === p.memoryId)
    : undefined;
  // Provenance (PM-14): pasted from another app, or found in one of your chats.
  const origin = {
    authority: p.sourceThreadId ? "extracted" : "imported",
    extractionMethod: p.sourceThreadId ? "chat" : "import",
    extractionModel: p.extractionModel ?? null,
  } as const;
  if (p.op === "add") {
    await addMemory(db, tenant, {
      text,
      kind: p.kind,
      projectId: p.projectId,
      sourceThreadId: p.sourceThreadId,
      confidence: p.confidence,
      ...origin,
    });
  } else if (p.op === "update" && target) {
    const newId = await addMemory(db, tenant, {
      text,
      kind: p.kind,
      projectId: target.projectId,
      threadId: target.threadId,
      sourceThreadId: p.sourceThreadId,
      confidence: p.confidence,
      ...origin,
    });
    await db.execute(
      `UPDATE memories SET superseded_by_id = ?, status = 'superseded', revision = revision + 1,
         updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
      [newId, Date.now(), tenant.workspaceId, target.id],
    );
  } else if (p.op === "delete" && target) {
    await deleteMemory(db, tenant, target.id);
  }
  await setProposalStatus(db, tenant, id, "approved");
}

export interface ReplacedMemory {
  id: string;
  text: string;
  /** The fact that replaced it. */
  newer: string;
  replacedAt: number;
}

/** PM-11: facts replaced by a newer version, newest change first (the last 50). */
export async function listReplaced(db: SqlDb, tenant: Tenant): Promise<ReplacedMemory[]> {
  const rows = await db.select<{ id: string; text: string; newer: string; updated_at: number }>(
    `SELECT m.id, m.text, n.text AS newer, m.updated_at FROM memories m
     JOIN memories n ON n.id = m.superseded_by_id
     WHERE m.workspace_id = ? AND m.status = 'superseded' AND n.status = 'active'
     ORDER BY m.updated_at DESC LIMIT 50`,
    [tenant.workspaceId],
  );
  return rows.map((r) => ({ id: r.id, text: r.text, newer: r.newer, replacedAt: r.updated_at }));
}

/** Brings a replaced fact back; the one that replaced it becomes the history instead. */
export async function restoreMemory(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const [row] = await db.select<{ superseded_by_id: string | null }>(
    `SELECT superseded_by_id FROM memories WHERE workspace_id = ? AND id = ?`,
    [tenant.workspaceId, id],
  );
  const newer = row?.superseded_by_id;
  if (!newer) return;
  const now = Date.now();
  await db.execute(
    `UPDATE memories SET superseded_by_id = NULL, status = 'active', revision = revision + 1,
       updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [now, tenant.workspaceId, id],
  );
  await db.execute(
    `UPDATE memories SET superseded_by_id = ?, status = 'superseded', revision = revision + 1,
       updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [id, now, tenant.workspaceId, newer],
  );
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
