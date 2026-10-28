/**
 * Claude's data export (Settings → Privacy → Export data): a zip with conversations.json (each
 * chat's messages, oldest first, with parent ids in newer exports) and projects.json (each
 * project's instructions and documents). Turned into ImportedChat and projects (PL-08).
 */
import { strFromU8, unzipSync } from "fflate";
import type { ImportedChat, ImportedMessage } from "./write";

interface ClaudeMessage {
  uuid?: string;
  parent_message_uuid?: string | null;
  sender?: string;
  text?: string;
  content?: { type?: string; text?: string }[];
  created_at?: string;
  attachments?: { file_name?: string }[];
  files?: { file_name?: string }[];
}

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  project_uuid?: string | null;
  project?: { uuid?: string } | null;
  chat_messages?: ClaudeMessage[];
}

interface ClaudeProject {
  uuid?: string;
  name?: string;
  prompt_template?: string;
  description?: string;
  docs?: { filename?: string; content?: string }[];
}

export interface ImportedProject {
  name: string;
  instructions: string;
  docs: { name: string; text: string }[];
}

const time = (iso: string | undefined, fallback: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? fallback : t;
};

/** The message's text: content blocks when present (newer exports), else `text`. Files noted. */
function textOf(m: ClaudeMessage): string {
  const blocks = (m.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "");
  const body = (blocks.length > 0 ? blocks.join("\n\n") : (m.text ?? "")).trim();
  const files = [...(m.attachments ?? []), ...(m.files ?? [])]
    .map((f) => f.file_name)
    .filter((n): n is string => Boolean(n))
    .map((n) => `[Attached: ${n}]`);
  return [body, ...files].filter(Boolean).join("\n\n");
}

export function parseClaude(
  conversations: readonly ClaudeConversation[],
  projects: readonly ClaudeProject[],
): { chats: ImportedChat[]; projects: ImportedProject[] } {
  const projectName = new Map(
    projects.filter((p) => p.uuid && p.name).map((p) => [p.uuid ?? "", p.name ?? ""]),
  );
  const chats: ImportedChat[] = [];
  for (const [i, c] of conversations.entries()) {
    const created = time(c.created_at, 0);
    const messages: ImportedMessage[] = [];
    let previous: string | null = null;
    for (const [n, m] of (c.chat_messages ?? []).entries()) {
      const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
      const content = textOf(m);
      if (!role || !content) continue;
      const id = m.uuid ?? `${String(i)}-${String(n)}`;
      // Newer exports give each message's parent (edits make branches); older ones are a list.
      const parent =
        m.parent_message_uuid && m.parent_message_uuid !== "00000000-0000-4000-8000-000000000000"
          ? m.parent_message_uuid
          : previous;
      messages.push({
        id,
        parentId: parent,
        role,
        content,
        model: null,
        createdAt: time(m.created_at, created + n),
      });
      previous = id;
    }
    // A parent that was skipped (empty or unknown sender) means "follow the list".
    const ids = new Set(messages.map((m) => m.id));
    for (const [n, m] of messages.entries()) {
      if (m.parentId && !ids.has(m.parentId)) m.parentId = messages[n - 1]?.id ?? null;
    }
    if (messages.length === 0) continue;
    const pid = c.project_uuid ?? c.project?.uuid ?? null;
    chats.push({
      externalId: c.uuid ?? `claude-${String(i)}-${String(created)}`,
      title: c.name?.trim() || "Imported chat",
      createdAt: created || (messages[0]?.createdAt ?? 0),
      updatedAt: time(c.updated_at, created),
      messages,
      leafId: messages.at(-1)?.id ?? null,
      projectName: pid ? (projectName.get(pid) ?? null) : null,
    });
  }
  return {
    chats,
    projects: projects
      .filter((p) => p.name?.trim())
      .map((p) => ({
        name: (p.name ?? "").trim(),
        instructions: (p.prompt_template ?? "").trim(),
        docs: (p.docs ?? [])
          .filter((d) => d.filename && d.content?.trim())
          .map((d) => ({ name: d.filename ?? "", text: d.content ?? "" })),
      })),
  };
}

/** Reads Claude's export zip (or a bare conversations.json). Throws a plain-English error. */
export function readClaudeExport(
  bytes: Uint8Array,
  fileName: string,
): { chats: ImportedChat[]; projects: ImportedProject[] } {
  if (fileName.toLowerCase().endsWith(".json")) {
    const data = JSON.parse(strFromU8(bytes)) as unknown;
    if (!Array.isArray(data)) throw new Error("That file has no chats.");
    return parseClaude(data as ClaudeConversation[], []);
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => /(^|\/)(conversations|projects)\.json$/.test(f.name),
    });
  } catch {
    throw new Error("That isn't a zip file. Pick the export zip Claude emailed you.");
  }
  const read = (name: string): unknown[] => {
    const key = Object.keys(files).find((k) => k === name || k.endsWith(`/${name}`));
    const data = key ? (JSON.parse(strFromU8(files[key] ?? new Uint8Array())) as unknown) : [];
    return Array.isArray(data) ? data : [];
  };
  const conversations = read("conversations.json") as ClaudeConversation[];
  if (
    conversations.length === 0 &&
    !Object.keys(files).some((k) => k.endsWith("conversations.json"))
  ) {
    throw new Error("No conversations.json in that zip. Is it a Claude data export?");
  }
  return parseClaude(conversations, read("projects.json") as ClaudeProject[]);
}
