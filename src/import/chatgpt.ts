/**
 * ChatGPT's data export (Settings → Data controls → Export): a zip whose conversations.json (or
 * conversations-000.json, …) holds each chat as a tree of nodes. Turned into ImportedChat (PL-08).
 */
import { strFromU8, unzipSync } from "fflate";
import type { ImportedChat, ImportedMessage } from "./write";

interface Node {
  id: string;
  parent?: string | null;
  message?: {
    id?: string;
    author?: { role?: string };
    create_time?: number | null;
    content?: { content_type?: string; parts?: unknown[]; text?: string };
    metadata?: { model_slug?: string; is_visually_hidden_from_conversation?: boolean };
  } | null;
}

interface Conversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  current_node?: string | null;
  mapping?: Record<string, Node>;
}

/** The text of a message, images and other non-text parts noted in brackets. */
function textOf(content: NonNullable<Node["message"]>["content"]): string {
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  return (content.parts ?? [])
    .map((p) =>
      typeof p === "string"
        ? p
        : p && typeof p === "object" && "content_type" in p
          ? `[${String(p.content_type).replace(/_/g, " ")}]`
          : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function parseConversations(conversations: readonly Conversation[]): ImportedChat[] {
  const out: ImportedChat[] = [];
  for (const [i, c] of conversations.entries()) {
    const mapping = c.mapping ?? {};
    const created = Math.round((c.create_time ?? 0) * 1000);
    // Kept nodes: user and assistant messages with text, shown in the conversation.
    const kept = new Map<string, ImportedMessage>();
    let order = 0;
    for (const node of Object.values(mapping)) {
      const m = node.message;
      const role = m?.author?.role;
      if (!m || (role !== "user" && role !== "assistant")) continue;
      if (m.metadata?.is_visually_hidden_from_conversation) continue;
      const text = textOf(m.content);
      if (!text) continue;
      kept.set(node.id, {
        id: node.id,
        parentId: null,
        role,
        content: text,
        model: role === "assistant" ? (m.metadata?.model_slug ?? null) : null,
        createdAt: m.create_time ? Math.round(m.create_time * 1000) : created + order++,
      });
    }
    // Each kept message's parent is its nearest kept ancestor (system and tool nodes are skipped).
    const nearestKept = (id: string | null | undefined): string | null => {
      let cur = id ?? null;
      for (let guard = 0; cur && guard < 100_000; guard++) {
        if (kept.has(cur)) return cur;
        cur = mapping[cur]?.parent ?? null;
      }
      return null;
    };
    for (const [id, m] of kept) m.parentId = nearestKept(mapping[id]?.parent);
    const messages = [...kept.values()];
    if (messages.length === 0) continue;
    out.push({
      externalId: c.conversation_id ?? c.id ?? `untitled-${String(i)}-${String(created)}`,
      title: c.title?.trim() || "Imported chat",
      createdAt: created || (messages[0]?.createdAt ?? 0),
      updatedAt: Math.round((c.update_time ?? c.create_time ?? 0) * 1000),
      messages,
      leafId: nearestKept(c.current_node),
    });
  }
  return out;
}

/** Reads the export zip (or a bare conversations.json). Throws a plain-English error. */
export function readChatGptExport(bytes: Uint8Array, fileName: string): ImportedChat[] {
  const json: unknown[] = [];
  if (fileName.toLowerCase().endsWith(".json")) {
    json.push(JSON.parse(strFromU8(bytes)) as unknown);
  } else {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter: (f) => /(^|\/)conversations(-\d+)?\.json$/.test(f.name) });
    } catch {
      throw new Error("That isn't a zip file. Pick the export zip ChatGPT emailed you.");
    }
    for (const name of Object.keys(files).sort()) {
      json.push(JSON.parse(strFromU8(files[name] ?? new Uint8Array())) as unknown);
    }
    if (json.length === 0) {
      throw new Error("No conversations.json in that zip. Is it a ChatGPT data export?");
    }
  }
  const all = json.flatMap((j) => (Array.isArray(j) ? (j as Conversation[]) : []));
  if (all.length === 0) throw new Error("No chats found in that export.");
  return parseConversations(all);
}
