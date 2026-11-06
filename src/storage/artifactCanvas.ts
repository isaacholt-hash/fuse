/**
 * M17.2 writing canvas: comments anchored to an exact artifact version, and AI writing proposals
 * that become a new version only when the owner accepts them against the version they started from.
 */
import { locateAnchor, type TextAnchor } from "@/artifacts/sections";
import { resolveArtifactId } from "@/sync/aliases";
import { versionInsert } from "./artifactWrites";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export interface ArtifactComment extends TextAnchor {
  id: string;
  artifactId: string;
  body: string;
  resolvedAt: number | null;
  createdAt: number;
}

export type WritingAction = "rewrite" | "shorten" | "expand";

export interface ArtifactProposal {
  id: string;
  artifactId: string;
  /** The version the request started from; accepting requires it to still be the latest. */
  baseVersionId: string | null;
  messageId: string | null;
  start: number;
  end: number;
  instruction: string;
  content: string | null;
  state: "requested" | "pending" | "accepted" | "discarded" | "interrupted";
  createdAt: number;
}

const MAX_BODY = 8000;

async function latestVersionId(db: SqlDb, t: Tenant, artifactId: string): Promise<string | null> {
  const [row] = await db.select<{ id: string }>(
    `SELECT id FROM artifact_versions WHERE workspace_id=? AND user_id=? AND artifact_id=?
     ORDER BY version DESC,id DESC LIMIT 1`,
    [t.workspaceId, t.userId, artifactId],
  );
  return row?.id ?? null;
}

/** A comment on a passage of one saved version. The quote is checked against that version. */
export async function addComment(
  db: SqlDb,
  t: Tenant,
  artifactId: string,
  anchor: TextAnchor,
  body: string,
): Promise<ArtifactComment> {
  artifactId = await resolveArtifactId(db, t, artifactId);
  const text = body.trim();
  if (!text || text.length > MAX_BODY)
    throw new Error("Write a comment of up to 8,000 characters.");
  const [version] = await db.select<{ content: string }>(
    `SELECT v.content FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id
     WHERE v.workspace_id=? AND v.user_id=? AND v.id=? AND v.artifact_id=? AND a.deleted_at IS NULL`,
    [t.workspaceId, t.userId, anchor.versionId, artifactId],
  );
  if (!version || version.content.slice(anchor.start, anchor.end) !== anchor.quote)
    throw new Error("That passage isn't in the saved version. Select it again.");
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO artifact_comments(id,workspace_id,user_id,artifact_id,version_id,anchor_start,
       anchor_end,quote,body,resolved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    [
      id,
      t.workspaceId,
      t.userId,
      artifactId,
      anchor.versionId,
      anchor.start,
      anchor.end,
      anchor.quote,
      text,
      now,
      now,
    ],
  );
  return { id, artifactId, ...anchor, body: text, resolvedAt: null, createdAt: now };
}

export async function listComments(
  db: SqlDb,
  t: Tenant,
  artifactId: string,
): Promise<ArtifactComment[]> {
  artifactId = await resolveArtifactId(db, t, artifactId);
  const rows = await db.select<{
    id: string;
    version_id: string;
    anchor_start: number;
    anchor_end: number;
    quote: string;
    body: string;
    resolved_at: number | null;
    created_at: number;
  }>(
    `SELECT id,version_id,anchor_start,anchor_end,quote,body,resolved_at,created_at
     FROM artifact_comments WHERE workspace_id=? AND user_id=? AND artifact_id=?
     ORDER BY created_at,id`,
    [t.workspaceId, t.userId, artifactId],
  );
  return rows.map((r) => ({
    id: r.id,
    artifactId,
    versionId: r.version_id,
    start: r.anchor_start,
    end: r.anchor_end,
    quote: r.quote,
    body: r.body,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  }));
}

export async function setCommentResolved(
  db: SqlDb,
  t: Tenant,
  id: string,
  resolved: boolean,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE artifact_comments SET resolved_at=?,updated_at=? WHERE workspace_id=? AND user_id=? AND id=?`,
    [resolved ? now : null, now, t.workspaceId, t.userId, id],
  );
}

export async function deleteComment(db: SqlDb, t: Tenant, id: string): Promise<void> {
  await db.execute(`DELETE FROM artifact_comments WHERE workspace_id=? AND user_id=? AND id=?`, [
    t.workspaceId,
    t.userId,
    id,
  ]);
}

/**
 * Moves a comment whose passage changed to the owner-confirmed position in the latest version.
 * Only a unique match offered by locateAnchor can be confirmed; nothing moves silently.
 */
export async function reattachComment(
  db: SqlDb,
  t: Tenant,
  comment: ArtifactComment,
): Promise<ArtifactComment> {
  const latest = await latestVersionId(db, t, comment.artifactId);
  const [version] = await db.select<{ content: string }>(
    `SELECT content FROM artifact_versions WHERE workspace_id=? AND user_id=? AND id=?`,
    [t.workspaceId, t.userId, latest],
  );
  if (!latest || !version) throw new Error("The artifact has no saved version.");
  const place = locateAnchor(comment, latest, version.content);
  if (place.start === null || place.end === null)
    throw new Error("That passage isn't in the latest version, so the comment stays where it was.");
  const now = Date.now();
  await db.execute(
    `UPDATE artifact_comments SET version_id=?,anchor_start=?,anchor_end=?,updated_at=?
     WHERE workspace_id=? AND user_id=? AND id=? AND version_id=?`,
    [latest, place.start, place.end, now, t.workspaceId, t.userId, comment.id, comment.versionId],
  );
  return { ...comment, versionId: latest, start: place.start, end: place.end };
}

/** Records a writing request before it is sent, so an interrupted reply is visible, not lost. */
export async function requestProposal(
  db: SqlDb,
  t: Tenant,
  p: { artifactId: string; baseVersionId: string; start: number; end: number; instruction: string },
): Promise<string> {
  const artifactId = await resolveArtifactId(db, t, p.artifactId);
  if (p.instruction.length > MAX_BODY)
    throw new Error("Keep the instruction under 8,000 characters.");
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO artifact_proposals(id,workspace_id,user_id,artifact_id,base_version_id,message_id,
       anchor_start,anchor_end,instruction,content,state,created_at,updated_at)
     VALUES (?,?,?,?,?,NULL,?,?,?,NULL,'requested',?,?)`,
    [
      id,
      t.workspaceId,
      t.userId,
      artifactId,
      p.baseVersionId,
      p.start,
      p.end,
      p.instruction,
      now,
      now,
    ],
  );
  return id;
}

/** The reply's artifact becomes the proposal's candidate; it never becomes a version by itself. */
export async function fillProposal(
  db: SqlDb,
  t: Tenant,
  id: string,
  messageId: string,
  content: string | null,
): Promise<void> {
  await db.execute(
    `UPDATE artifact_proposals SET message_id=?,content=?,state=?,updated_at=?
     WHERE workspace_id=? AND user_id=? AND id=? AND state='requested'`,
    [
      messageId,
      content,
      content === null ? "interrupted" : "pending",
      Date.now(),
      t.workspaceId,
      t.userId,
      id,
    ],
  );
}

/** A request that never got its reply (stopped, failed, crashed) stops waiting. */
export async function interruptProposal(db: SqlDb, t: Tenant, id: string): Promise<void> {
  await db.execute(
    `UPDATE artifact_proposals SET state='interrupted',updated_at=?
     WHERE workspace_id=? AND user_id=? AND id=? AND state='requested'`,
    [Date.now(), t.workspaceId, t.userId, id],
  );
}

/** Pending and interrupted proposals, newest last; accepted and discarded ones are history. */
export async function listProposals(
  db: SqlDb,
  t: Tenant,
  artifactId: string,
): Promise<ArtifactProposal[]> {
  artifactId = await resolveArtifactId(db, t, artifactId);
  const rows = await db.select<{
    id: string;
    base_version_id: string | null;
    message_id: string | null;
    anchor_start: number;
    anchor_end: number;
    instruction: string;
    content: string | null;
    state: ArtifactProposal["state"];
    created_at: number;
  }>(
    `SELECT id,base_version_id,message_id,anchor_start,anchor_end,instruction,content,state,created_at
     FROM artifact_proposals WHERE workspace_id=? AND user_id=? AND artifact_id=?
       AND state IN ('requested','pending','interrupted') ORDER BY created_at,id`,
    [t.workspaceId, t.userId, artifactId],
  );
  return rows.map((r) => ({
    id: r.id,
    artifactId,
    baseVersionId: r.base_version_id,
    messageId: r.message_id,
    start: r.anchor_start,
    end: r.anchor_end,
    instruction: r.instruction,
    content: r.content,
    state: r.state,
    createdAt: r.created_at,
  }));
}

export class StaleProposalError extends Error {
  constructor() {
    super(
      "The document changed after this was proposed. Discard it, or ask again from the latest version.",
    );
  }
}

/**
 * Accepts a reviewed proposal as a new AI version, in one batch that only applies while the
 * proposal's base is still the latest version. Returns the new version's id.
 */
export async function acceptProposal(db: SqlDb, t: Tenant, id: string): Promise<string> {
  const [p] = await db.select<{
    artifact_id: string;
    base_version_id: string | null;
    message_id: string | null;
    content: string | null;
    state: string;
  }>(
    `SELECT artifact_id,base_version_id,message_id,content,state FROM artifact_proposals
     WHERE workspace_id=? AND user_id=? AND id=?`,
    [t.workspaceId, t.userId, id],
  );
  if (!p || p.state !== "pending" || p.content === null)
    throw new Error("This proposal is no longer waiting for review.");
  if ((await latestVersionId(db, t, p.artifact_id)) !== p.base_version_id)
    throw new StaleProposalError();
  const now = Date.now();
  const versionId = uuidv7(now);
  const result = await db.batch([
    versionInsert(t, {
      id: versionId,
      artifactId: p.artifact_id,
      baseId: p.base_version_id,
      content: p.content,
      source: "model",
      messageId: p.message_id,
      now,
      guard: `EXISTS(SELECT 1 FROM artifact_proposals WHERE workspace_id=? AND user_id=? AND id=? AND state='pending')`,
      params: [t.workspaceId, t.userId, id],
    }),
    {
      sql: `UPDATE artifact_proposals SET state='accepted',accepted_version_id=?,updated_at=?
            WHERE workspace_id=? AND user_id=? AND id=? AND EXISTS(SELECT 1 FROM artifact_versions WHERE id=?)`,
      params: [versionId, now, t.workspaceId, t.userId, id, versionId],
    },
    {
      sql: `UPDATE artifacts SET updated_at=? WHERE workspace_id=? AND user_id=? AND id=?
            AND EXISTS(SELECT 1 FROM artifact_versions WHERE id=?)`,
      params: [now, t.workspaceId, t.userId, p.artifact_id, versionId],
    },
  ]);
  if (result[0]?.rowsAffected !== 1) throw new StaleProposalError();
  return versionId;
}

export async function discardProposal(db: SqlDb, t: Tenant, id: string): Promise<void> {
  await db.execute(
    `UPDATE artifact_proposals SET state='discarded',updated_at=?
     WHERE workspace_id=? AND user_id=? AND id=? AND state IN ('requested','pending','interrupted')`,
    [Date.now(), t.workspaceId, t.userId, id],
  );
}

/** The instruction sent for a section action; the model replies with the whole artifact. */
export function writingInstruction(action: WritingAction, sectionTitle: string): string {
  const what = sectionTitle ? `the "${sectionTitle}" part` : "the selected part";
  switch (action) {
    case "rewrite":
      return `Rewrite ${what} so it reads more clearly. Keep its meaning, facts and Markdown structure.`;
    case "shorten":
      return `Shorten ${what} to about half its length. Keep the key points and Markdown structure.`;
    case "expand":
      return `Expand ${what} with more detail and examples. Don't invent facts; keep the Markdown structure.`;
  }
}
