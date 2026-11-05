// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import {
  readSkillPackage,
  skillBytes,
  skillPath,
  skillText,
  verifySkillPackage,
  SKILL_LIMITS,
} from "./package";

const zip = (extra: Record<string, Uint8Array> = {}) =>
  zipSync({ "SKILL.md": strToU8("Use short, cited release notes."), ...extra });

test("ordinary ZIP and single-folder packages preserve bounded support files and inert scripts", async () => {
  const p = await readSkillPackage(
    "C:\\Downloads\\notes.zip",
    zip({
      "scripts/notes.py": strToU8("print('recorded')"),
      "references/format.txt": strToU8("Summary / Changes"),
    }),
  );
  expect(p.source).toBe("notes.zip");
  expect(p.assets).toHaveLength(3);
  const script = p.assets.find((a) => a.path === "scripts/notes.py");
  if (!script) throw new Error("fixture script");
  expect(skillText(skillBytes(script))).toBe("print('recorded')");
  expect(await verifySkillPackage(p)).toEqual(p);
  const nested = await readSkillPackage(
    "folder.zip",
    zipSync({ "notes/SKILL.md": strToU8("Write notes."), "notes/a.txt": strToU8("data") }),
  );
  expect(nested.assets.map((a) => a.path)).toEqual(["SKILL.md", "a.txt"]);
});

test.each([
  "../escape.py",
  "/absolute.py",
  "C:/run.py",
  "a\\b.py",
  "file:stream",
  "NUL.txt",
  "con.py",
  "COM1.log",
  "LPT9",
  "a/../x",
  "a./x",
  "a /x",
  ".env",
  "a/.env.local",
  ".git/config",
  "a/__proto__",
  "bad\u0000name",
  "café.txt",
])("refuses unsafe portable path %s", async (path) => {
  expect(() => skillPath(path)).toThrow();
  await expect(
    readSkillPackage("bad.zip", zip({ [path]: strToU8("untrusted") })),
  ).rejects.toThrow();
});

test("refuses case collisions, file/folder collisions and missing instructions", async () => {
  await expect(
    readSkillPackage("bad.zip", zip({ "a.txt": strToU8("a"), "A.TXT": strToU8("b") })),
  ).rejects.toThrow(/repeat/);
  await expect(
    readSkillPackage("bad.zip", zip({ A: strToU8("a"), "a/b": strToU8("b") })),
  ).rejects.toThrow(/folder/);
  await expect(readSkillPackage("bad.zip", zipSync({ "other.txt": strToU8("a") }))).rejects.toThrow(
    /SKILL.md/,
  );
});

test("rejects symlinks, corrupt CRC, inconsistent headers and encrypted entries before import", async () => {
  const original = zip({ "ref.txt": strToU8("reference") });
  const find = (b: Uint8Array, signature: number) => {
    const v = new DataView(b.buffer);
    for (let p = 0; p < b.length - 4; p++) if (v.getUint32(p, true) === signature) return p;
    throw new Error("missing fixture header");
  };
  for (const mutate of [
    (b: Uint8Array) => {
      new DataView(b.buffer).setUint32(find(b, 0x02014b50) + 38, 0xa1ff0000, true);
    },
    (b: Uint8Array) => {
      new DataView(b.buffer).setUint32(find(b, 0x02014b50) + 16, 1, true);
    },
    (b: Uint8Array) => {
      b[30] = 0x78;
    },
    (b: Uint8Array) => {
      new DataView(b.buffer).setUint16(find(b, 0x02014b50) + 8, 1, true);
    },
  ]) {
    const bytes = original.slice();
    mutate(bytes);
    await expect(readSkillPackage("bad.zip", bytes)).rejects.toThrow();
  }
});

test("bounds compressed input, inflated files, instruction bytes and entry count", async () => {
  await expect(
    readSkillPackage("bad.zip", new Uint8Array(SKILL_LIMITS.archive + 1)),
  ).rejects.toThrow(/2 MiB/);
  await expect(
    readSkillPackage("bad.zip", zip({ "huge.txt": new Uint8Array(SKILL_LIMITS.file + 1) })),
  ).rejects.toThrow(/limit/);
  await expect(
    readSkillPackage("SKILL.md", new Uint8Array(SKILL_LIMITS.instructions + 1)),
  ).rejects.toThrow(/32 KiB/);
  await expect(
    readSkillPackage(
      "many.zip",
      zip(
        Object.fromEntries(
          Array.from({ length: 64 }, (_, i) => [`${String(i)}.txt`, strToU8("x")]),
        ),
      ),
    ),
  ).rejects.toThrow(/entries/);
  await expect(readSkillPackage("SKILL.md", Uint8Array.of(0xff))).rejects.toThrow();
});

test("portable manifests cannot change bytes, instructions, paths or hashes behind a pin", async () => {
  const p = await readSkillPackage("SKILL.md", strToU8("Keep the original."));
  await expect(verifySkillPackage({ ...p, instructions: "Different" })).rejects.toThrow(
    /integrity/,
  );
  const a = p.assets[0];
  if (!a) throw new Error("fixture asset");
  await expect(
    verifySkillPackage({ ...p, assets: [{ ...a, path: "../outside" }] }),
  ).rejects.toThrow();
  await expect(
    verifySkillPackage({ ...p, assets: [{ ...a, sha256: "0".repeat(64) }] }),
  ).rejects.toThrow(/integrity/);
});
