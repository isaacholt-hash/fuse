// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import { readClaudeExport } from "./claude";

const zip = zipSync({
  "conversations.json": strToU8(
    JSON.stringify([
      {
        uuid: "c1",
        name: "Trip plan",
        created_at: "2026-05-01T10:00:00Z",
        updated_at: "2026-05-01T10:05:00Z",
        project_uuid: "p1",
        chat_messages: [
          {
            uuid: "m1",
            sender: "human",
            text: "Plan Lisbon",
            created_at: "2026-05-01T10:00:00Z",
            attachments: [{ file_name: "map.pdf" }],
          },
          {
            uuid: "m2",
            sender: "assistant",
            content: [{ type: "text", text: "Day 1: Alfama." }],
            created_at: "2026-05-01T10:01:00Z",
          },
          {
            uuid: "m3",
            sender: "human",
            parent_message_uuid: "m2",
            text: "And day 2?",
            created_at: "2026-05-01T10:02:00Z",
          },
        ],
      },
    ]),
  ),
  "projects.json": strToU8(
    JSON.stringify([
      {
        uuid: "p1",
        name: "Travel",
        prompt_template: "Prices in euros.",
        docs: [{ filename: "notes.md", content: "Hotel near Rossio." }],
      },
    ]),
  ),
  "users.json": strToU8("[]"),
});

test("a Claude export becomes chats (with their project) and projects with instructions and documents", () => {
  const { chats, projects } = readClaudeExport(zip, "export.zip");
  expect(chats).toHaveLength(1);
  expect(chats[0]).toMatchObject({
    externalId: "c1",
    title: "Trip plan",
    projectName: "Travel",
    leafId: "m3",
  });
  expect(chats[0]?.messages.map((m) => [m.id, m.parentId, m.role, m.content])).toEqual([
    ["m1", null, "user", "Plan Lisbon\n\n[Attached: map.pdf]"],
    ["m2", "m1", "assistant", "Day 1: Alfama."],
    ["m3", "m2", "user", "And day 2?"],
  ]);
  expect(projects).toEqual([
    {
      name: "Travel",
      instructions: "Prices in euros.",
      docs: [{ name: "notes.md", text: "Hotel near Rossio." }],
    },
  ]);
});

test("plain-English errors for the wrong file", () => {
  expect(() => readClaudeExport(strToU8("nope"), "x.zip")).toThrow(/isn't a zip/);
  expect(() => readClaudeExport(zipSync({ "a.txt": strToU8("x") }), "x.zip")).toThrow(
    /No conversations\.json/,
  );
});
