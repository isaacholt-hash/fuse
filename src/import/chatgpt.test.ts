// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listPath } from "@/storage/messages";
import { openTestDb } from "@/storage/testing/nodeDb";
import { listThreads } from "@/storage/threads";
import { buildPath } from "@/storage/tree";
import { readChatGptExport } from "./chatgpt";
import { previewImport, writeImport } from "./write";

const t = DEFAULT_TENANT;
const node = (
  id: string,
  parent: string | null,
  role: string | null,
  text: string,
  time: number,
  extra = {},
) => ({
  id,
  parent,
  message: role
    ? {
        id,
        author: { role },
        create_time: time,
        content: { content_type: "text", parts: [text] },
        metadata: { model_slug: role === "assistant" ? "gpt-4o" : undefined, ...extra },
      }
    : null,
});
// root → system → user q → assistant a1, and an edited question q2 → a2 (the current branch).
const exportZip = zipSync({
  "conversations.json": strToU8(
    JSON.stringify([
      {
        conversation_id: "c1",
        title: "Garden plans",
        create_time: 1_700_000_000,
        update_time: 1_700_000_100,
        current_node: "a2",
        mapping: {
          root: node("root", null, null, "", 0),
          sys: node("sys", "root", "system", "You are ChatGPT", 1_700_000_000, {
            is_visually_hidden_from_conversation: true,
          }),
          q: node("q", "sys", "user", "What should I plant?", 1_700_000_001),
          a1: node("a1", "q", "assistant", "Tomatoes.", 1_700_000_002),
          tool: node("tool", "q", "tool", "search results", 1_700_000_003),
          q2: node("q2", "sys", "user", "What should I plant in shade?", 1_700_000_004),
          a2: node("a2", "q2", "assistant", "Ferns.", 1_700_000_005),
        },
      },
      { conversation_id: "empty", title: "Nothing", create_time: 1, mapping: {} },
    ]),
  ),
  "chat.html": strToU8("<html></html>"),
});

test("a ChatGPT export becomes chats with their branches, dates and current branch; re-running skips them", async () => {
  const chats = readChatGptExport(exportZip, "export.zip");
  expect(chats).toHaveLength(1);
  expect(chats[0]?.messages.map((m) => [m.id, m.parentId, m.role])).toEqual(
    expect.arrayContaining([
      ["q", null, "user"],
      ["a1", "q", "assistant"],
      ["q2", null, "user"],
      ["a2", "q2", "assistant"],
    ]),
  );
  const db = openTestDb();
  expect(await previewImport(db, t, "chatgpt", chats)).toEqual({
    chats: 1,
    messages: 4,
    already: 0,
  });
  expect(await writeImport(db, t, "chatgpt", chats)).toBe(1);
  const [thread] = await listThreads(db, t);
  expect(thread).toMatchObject({ title: "Garden plans", createdAt: 1_700_000_000_000 });
  const { all, path } = await listPath(db, t, thread?.id ?? "");
  expect(path.map((m) => m.content)).toEqual(["What should I plant in shade?", "Ferns."]);
  expect(path[1]).toMatchObject({
    provider: "openai",
    model: "gpt-4o",
    createdAt: 1_700_000_005_000,
  });
  expect(
    buildPath(all, all.find((m) => m.content === "Tomatoes.")?.id ?? null).map((m) => m.content),
  ).toEqual(["What should I plant?", "Tomatoes."]);
  expect(await previewImport(db, t, "chatgpt", chats)).toEqual({
    chats: 0,
    messages: 0,
    already: 1,
  });
  expect(await writeImport(db, t, "chatgpt", chats)).toBe(0);
  expect(await listThreads(db, t)).toHaveLength(1);
});

test("plain-English errors for the wrong file", () => {
  expect(() => readChatGptExport(strToU8("hello"), "x.zip")).toThrow(/isn't a zip/);
  expect(() => readChatGptExport(zipSync({ "a.txt": strToU8("x") }), "x.zip")).toThrow(
    /No conversations\.json/,
  );
});
