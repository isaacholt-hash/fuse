// @vitest-environment node
// M7 step 10 (LL-05): smaller context. Files are searched by word on this computer (no key
// needed), requests stay under their ceiling, and what's left out is said and recorded.
import raw from "../../data/context.json";
import { memoryFilesApi } from "@/files/api";
import { retrieveExcerpts, fuse } from "@/knowledge/retrieve";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addFile } from "@/storage/files";
import { openTestDb } from "@/storage/testing/nodeDb";
import { lexicalNearest, lexicalQuery, listChunks, type Match } from "@/storage/vectors";
import type { ChatMessage } from "@/providers/types";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { createThread } from "@/storage/threads";
import { assemble } from "./assemble";
import { ceilings, chatCeiling, clipToTokens, parseCeilings, trimHistory } from "./ceilings";

const t = DEFAULT_TENANT;

/** A long manual: 1,200 sections, one of which is about the warranty. */
const MANUAL = Array.from({ length: 1200 }, (_, i) =>
  i === 871
    ? `Section ${String(i)}. Warranty: the kettle is covered for 24 months from purchase; keep the receipt.`
    : `Section ${String(i)}. Descale the heating element with citric acid every ${String((i % 9) + 2)} weeks, then rinse twice.`,
).join("\n");

async function manual() {
  const db = openTestDb();
  const files = memoryFilesApi();
  const bytes = new TextEncoder().encode(MANUAL);
  const { sha256, size } = await files.put(bytes);
  const file = await addFile(db, t, {
    name: "kettle-manual.txt",
    mime: "text/plain",
    sizeBytes: size,
    sha256,
    width: null,
    height: null,
    tokenEstimate: Math.ceil(MANUAL.length / 4),
    threadId: null,
  });
  return { db, files, file };
}

test("a large file is searched by word with no embedding model: bounded, cited, on topic", async () => {
  const { db, files, file } = await manual();
  const deps = {
    db,
    tenant: t,
    files,
    priceVersion: "2026-10-30",
    adapterFor: () => {
      throw new Error("no provider may be called");
    },
  };
  const out = await retrieveExcerpts(deps, null, [file], "How long is the warranty?", null);
  expect(out.text).toContain("covered for 24 months");
  expect(out.sources.length).toBeLessThanOrEqual(8);
  // The whole manual is ~28K tokens; what's sent is a small, bounded part of it.
  expect(Math.ceil(out.text.length / 4)).toBeLessThan(4_500);
  expect(MANUAL.length / 4).toBeGreaterThan(20_000);
  expect(out.sources[0]?.label).toMatch(/^kettle-manual\.txt, lines? /);
});

test("lexical search: any of the question's words, stopwords dropped, nothing is syntax", async () => {
  expect(lexicalQuery("What is the warranty?")).toBe('"warranty"');
  // FTS5 syntax in the question is just words; one-letter words and stopwords are dropped.
  expect(lexicalQuery('a "b" OR NEAR(c) -d* kettle')).toBe('"near" OR "kettle"');
  expect(lexicalQuery("the of and")).toBeNull();
  // Before the file is chunked there's nothing to find.
  const { db, file } = await manual();
  expect(await lexicalNearest(db, t, "warranty", { kind: "file", ids: [file.id] })).toEqual([]);
});

test("rank fusion: a chunk high in either list rises; ties keep both", () => {
  const m = (id: string): Match => ({
    chunk: {
      id,
      sourceKind: "file",
      sourceId: "f",
      ordinal: 0,
      text: id,
      tokens: 1,
      page: null,
      lineStart: null,
      lineEnd: null,
    },
    score: 1,
  });
  expect(
    fuse(
      [
        [m("a"), m("b")],
        [m("b"), m("c")],
      ],
      3,
    ).map((x) => x.chunk.id),
  ).toEqual(["b", "a", "c"]);
  expect(fuse([[], []], 3)).toEqual([]);
});

test("the chat ceiling: the smaller of its cap and a share of the model's context", () => {
  expect(chatCeiling({ contextWindow: 1_000_000 })).toBe(400_000);
  expect(chatCeiling({ contextWindow: 200_000 })).toBe(150_000);
  expect(() => parseCeilings({ ...raw, chat: { share_of_context: 2, max_tokens: 1 } })).toThrow(
    /at most 1/,
  );
  expect(ceilings.localInputTokens).toBeLessThan(4096);
});

test("trimming keeps the newest messages, starts on a user turn, and counts what it left", () => {
  const msg = (role: ChatMessage["role"], n: number): ChatMessage => ({
    role,
    content: "x".repeat(n * 4),
  });
  const history = [
    msg("user", 100),
    msg("assistant", 100),
    msg("user", 100),
    msg("assistant", 100),
    msg("user", 50),
  ];
  const cut = trimHistory(history, 260);
  expect(cut.dropped).toBe(2);
  expect(cut.kept[0]?.role).toBe("user");
  expect(cut.kept).toHaveLength(3);
  expect(cut.droppedTokens).toBe(200);
  // The latest message stays even if it's over the budget on its own.
  expect(trimHistory([msg("user", 1000)], 10).kept).toHaveLength(1);
  expect(trimHistory(history, 10_000).dropped).toBe(0);
});

test("housekeeping input is clipped with a marker", () => {
  expect(clipToTokens("short", 10)).toBe("short");
  const clipped = clipToTokens("y".repeat(100), 10);
  expect(clipped.startsWith("y".repeat(40))).toBe(true);
  expect(clipped).toMatch(/60 more characters left out/);
});

test("chunks are found by word once saved (the FTS index follows inserts and deletes)", async () => {
  const { db, files, file } = await manual();
  const deps = {
    db,
    tenant: t,
    files,
    priceVersion: "x",
    adapterFor: () => {
      throw new Error("unused");
    },
  };
  await retrieveExcerpts(deps, null, [file], "warranty", null);
  expect((await listChunks(db, t, "file", file.id)).length).toBeGreaterThan(5);
  const hits = await lexicalNearest(db, t, "warranty receipt", { kind: "file", ids: [file.id] });
  expect(hits[0]?.chunk.text).toContain("Warranty");
});

test("over the ceiling, the request says what it left out, and the package records it", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t, "x");
  const deps = {
    db,
    tenant: t,
    catalog: defaultCatalog,
    adapterFor: () => {
      throw new Error("unused");
    },
  };
  const say = (role: ChatMessage["role"], n: number): ChatMessage => ({
    role,
    content: "w ".repeat(n * 2),
  });
  const history = [
    say("user", 2000),
    say("assistant", 2000),
    say("user", 2000),
    say("assistant", 2000),
    say("user", 10),
  ];
  const pkg = await assemble(
    deps,
    thread.id,
    { history, earlier: null, fileSources: [] },
    null,
    3000,
  );
  expect(pkg.history.length).toBeLessThan(history.length);
  expect(pkg.history[0]?.role).toBe("user");
  expect(pkg.system).toMatch(/oldest messages of this chat weren't sent/);
  expect(pkg.parts.find((p) => p.kind === "trimmed")).toMatchObject({ sources: [/messages$/] });
  const roomy = await assemble(
    deps,
    thread.id,
    { history, earlier: null, fileSources: [] },
    null,
    1_000_000,
  );
  expect(roomy.history).toHaveLength(history.length);
  expect(roomy.parts.some((p) => p.kind === "trimmed")).toBe(false);
});
