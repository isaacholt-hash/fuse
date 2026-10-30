// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import type { RepoApi } from "@/repo/api";
import { runTool } from "./tools";

const DOCX = zipSync({
  "word/document.xml": strToU8(
    `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p><w:p><w:r><w:t>Ship it.</w:t></w:r></w:p></w:body></w:document>`,
  ),
});

function repo(files: Record<string, Uint8Array | string>): RepoApi {
  return {
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("unused")),
    list: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
    write: () => Promise.reject(new Error("unused")),
    remove: () => Promise.reject(new Error("unused")),
    move: () => Promise.reject(new Error("unused")),
    read: (_id, path) => {
      const f = files[path];
      return typeof f === "string"
        ? Promise.resolve({ path, content: f, offset: 0, totalBytes: f.length, truncated: false })
        : Promise.reject(new Error(`${path}: binary`));
    },
    readBytes: (_id, path) => {
      const f = files[path];
      return f instanceof Uint8Array
        ? Promise.resolve(f)
        : Promise.reject(new Error(`${path}: no such file`));
    },
  };
}

const call = (input: Record<string, unknown>) => ({
  id: "c",
  name: "read_document",
  input: { offset: null, sheet: null, range: null, ...input },
});

test("read_document: Word as text, PDF page by page, plain files as text, images refused plainly", async () => {
  const r = repo({
    "notes/plan.docx": DOCX,
    "report.pdf": new Uint8Array([1]),
    "todo.md": "- ship",
    "photo.jpg": new Uint8Array([1]),
  });
  expect(await runTool(r, "", call({ path: "notes/plan.docx" }))).toMatchObject({
    output: "# Plan\n\nShip it.",
    isError: false,
    folder: "notes",
  });
  const pdf = await runTool(r, "", call({ path: "report.pdf" }), () =>
    Promise.resolve(["Page one text", "Page two text"]),
  );
  expect(pdf.output).toBe("--- page 1 ---\nPage one text\n\n--- page 2 ---\nPage two text");
  expect((await runTool(r, "", call({ path: "todo.md" }))).output).toBe("- ship");
  expect(await runTool(r, "", call({ path: "photo.jpg" }))).toMatchObject({ isError: true });
  expect((await runTool(r, "", call({ path: "missing.docx" }))).output).toMatch(
    /^Error: .*no such file/,
  );
});
