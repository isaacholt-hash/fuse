/** Imported packages are inert bytes. Nothing is extracted to a caller supplied path. */
import { unzipSync } from "fflate";

export const SKILL_LIMITS = {
  archive: 2 * 1024 * 1024,
  total: 2 * 1024 * 1024,
  file: 256 * 1024,
  instructions: 32 * 1024,
  entries: 64,
} as const;

export interface SkillAsset {
  path: string;
  bytes: number;
  sha256: string;
  base64: string;
}
export interface SkillPackage {
  instructions: string;
  assets: SkillAsset[];
  sha256: string;
  source: string;
}

export function skillName(name: string): string {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name))
    throw new Error("Use a skill name of up to 48 lowercase letters, numbers and hyphens.");
  return name;
}

/** Deliberately portable paths: no links, Windows devices, alternate streams or hidden grants. */
export function skillPath(path: string): string {
  if (path.length > 240 || !/^[\x20-\x7e]+$/.test(path) || /[\\:<>"|?*]/.test(path))
    throw new Error("The package has an unsafe or nonportable file path.");
  const parts = path.split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) ||
        /^(\.env.*|\.git|\.ssh|\.config|node_modules|__proto__|constructor|prototype)$/i.test(p),
    )
  )
    throw new Error("The package has an unsafe or private file path.");
  return path;
}

export async function skillHash(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function skillBytes(asset: SkillAsset): Uint8Array {
  if (
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 0 ||
    asset.bytes > SKILL_LIMITS.file ||
    asset.base64.length > Math.ceil(SKILL_LIMITS.file / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)
  )
    throw new Error("The skill file is malformed or too large.");
  const bytes = Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0));
  if (bytes.length !== asset.bytes) throw new Error("The skill file has an invalid length.");
  return bytes;
}

export function skillText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("This skill file isn't UTF-8 text.");
  return text;
}

function base64(bytes: Uint8Array): string {
  // A bounded loop avoids spreading a 256 KiB argument list into a native function.
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate both ZIP directories before inflation: metadata, paths, overlap and bombs. */
function archiveEntries(bytes: Uint8Array): Map<string, { size: number; crc: number }> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => v.getUint16(p, true);
  const u32 = (p: number) => v.getUint32(p, true);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--;
  if (
    end < 0 ||
    u32(end) !== 0x06054b50 ||
    end + 22 + u16(end + 20) !== bytes.length ||
    u16(end + 4) !== 0 ||
    u16(end + 6) !== 0 ||
    u16(end + 8) !== u16(end + 10)
  )
    throw new Error("Use a single-volume, ordinary ZIP package.");
  const count = u16(end + 10),
    start = u32(end + 16),
    length = u32(end + 12);
  if (!count || count > SKILL_LIMITS.entries || start + length !== end)
    throw new Error("The skill archive has too many entries or invalid bounds.");
  const result = new Map<string, { size: number; crc: number }>();
  const names = new Set<string>(),
    spans: [number, number][] = [];
  let at = start,
    total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) throw new Error("Invalid ZIP directory.");
    const flags = u16(at + 8),
      method = u16(at + 10),
      crc = u32(at + 16);
    const compressed = u32(at + 20),
      size = u32(at + 24),
      nl = u16(at + 28);
    const extra = u16(at + 30),
      comment = u16(at + 32),
      local = u32(at + 42);
    const next = at + 46 + nl + extra + comment;
    if (
      next > end ||
      flags & ~0x080e ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      u16(at + 34) !== 0 ||
      [compressed, size, local].includes(0xffffffff)
    )
      throw new Error("Encrypted, ZIP64 or unsupported ZIP entries aren't accepted.");
    const name = skillText(bytes.subarray(at + 46, at + 46 + nl));
    const dir = name.endsWith("/");
    skillPath(dir ? name.slice(0, -1) : name);
    const key = name.replace(/\/$/, "").toLowerCase();
    if (names.has(key)) throw new Error("The package repeats a file name.");
    names.add(key);
    const attrs = u32(at + 38),
      kind = (attrs >>> 16) & 0xf000;
    if (
      (kind !== 0 && kind !== (dir ? 0x4000 : 0x8000)) ||
      Boolean(attrs & 0x400) ||
      (Boolean(attrs & 0x10) !== dir && Boolean(attrs & 0x10))
    )
      throw new Error("Skill packages cannot contain links or special files.");
    total += size;
    if (size > SKILL_LIMITS.file || total > SKILL_LIMITS.total || (dir && size !== 0))
      throw new Error("The package exceeds the skill file limits.");
    if (
      local + 30 > start ||
      u32(local) !== 0x04034b50 ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method ||
      u16(local + 26) !== nl
    )
      throw new Error("The ZIP's local and central metadata disagree.");
    const data = local + 30 + nl + u16(local + 28);
    if (
      data + compressed > start ||
      skillText(bytes.subarray(local + 30, local + 30 + nl)) !== name ||
      (!(flags & 8) &&
        (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size))
    )
      throw new Error("The ZIP's file data has invalid bounds.");
    let fileEnd = data + compressed;
    if (flags & 8) {
      if (fileEnd + 12 > start) throw new Error("Invalid ZIP data descriptor.");
      if (u32(fileEnd) === 0x08074b50) fileEnd += 4;
      if (
        fileEnd + 12 > start ||
        u32(fileEnd) !== crc ||
        u32(fileEnd + 4) !== compressed ||
        u32(fileEnd + 8) !== size
      )
        throw new Error("The ZIP data descriptor disagrees with its file.");
      fileEnd += 12;
    }
    spans.push([local, fileEnd]);
    if (!dir) result.set(name, { size, crc });
    at = next;
  }
  if (at !== end) throw new Error("Invalid ZIP directory length.");
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.some((s, n) => n > 0 && s[0] < (spans[n - 1]?.[1] ?? 0)))
    throw new Error("The ZIP contains overlapping file entries.");
  for (const name of names) {
    if (
      [...names].some((other) => other.startsWith(`${name}/`)) &&
      [...result.keys()].some((p) => p.toLowerCase() === name)
    )
      throw new Error("A package path is both a file and a folder.");
  }
  return result;
}

async function packageFrom(
  files: { path: string; bytes: Uint8Array }[],
  source: string,
): Promise<SkillPackage> {
  if (!files.length || files.length > SKILL_LIMITS.entries)
    throw new Error("The skill has no files or too many files.");
  const seen = new Set<string>();
  let total = 0;
  const assets: SkillAsset[] = [];
  for (const f of files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    skillPath(f.path);
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new Error("The skill repeats a portable path.");
    seen.add(key);
    total += f.bytes.length;
    if (f.bytes.length > SKILL_LIMITS.file || total > SKILL_LIMITS.total)
      throw new Error("The skill exceeds its file size limit.");
    assets.push({
      path: f.path,
      bytes: f.bytes.length,
      sha256: await skillHash(f.bytes),
      base64: base64(f.bytes),
    });
  }
  for (const path of seen)
    if ([...seen].some((p) => p.startsWith(`${path}/`)))
      throw new Error("A skill path is both a file and a folder.");
  const entry = files.find((f) => f.path === "SKILL.md");
  if (!entry || entry.bytes.length > SKILL_LIMITS.instructions)
    throw new Error("Include one SKILL.md, at most 32 KiB, at the package root.");
  const instructions = skillText(entry.bytes).trim();
  if (!instructions) throw new Error("SKILL.md is empty.");
  return {
    instructions,
    assets,
    sha256: await skillHash(new TextEncoder().encode(JSON.stringify(assets))),
    source,
  };
}

export async function readSkillPackage(name: string, bytes: Uint8Array): Promise<SkillPackage> {
  if (bytes.length > SKILL_LIMITS.archive) throw new Error("Skill imports are limited to 2 MiB.");
  // File.name is not trusted to be a base name; never retain an original machine path.
  const source = name.split(/[\\/]/).at(-1)?.slice(0, 100) ?? "import";
  if (name.toLowerCase().endsWith(".md")) return packageFrom([{ path: "SKILL.md", bytes }], source);
  if (!name.toLowerCase().endsWith(".zip"))
    throw new Error("Choose a SKILL.md file or ZIP package.");
  try {
    const expected = archiveEntries(bytes);
    const unpacked = unzipSync(bytes, { filter: (f) => expected.has(f.name) });
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const [path, meta] of expected) {
      const content = unpacked[path];
      if (!content || content.length !== meta.size || crc32(content) !== meta.crc)
        throw new Error("A skill file failed its checksum or length check.");
      files.push({ path, bytes: content });
    }
    // Accept the common single containing folder; no other entry is silently discarded.
    const prefix = files[0]?.path.includes("/") ? `${files[0].path.split("/")[0] ?? ""}/` : "";
    return await packageFrom(
      prefix && files.every((f) => f.path.startsWith(prefix))
        ? files.map((f) => ({ ...f, path: f.path.slice(prefix.length) }))
        : files,
      source,
    );
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "That skill archive isn't valid.", {
      cause: e,
    });
  }
}

/** Recheck portable records from sync/restore before use, never trust stored JSON as code. */
export async function verifySkillPackage(value: SkillPackage): Promise<SkillPackage> {
  if (!Array.isArray(value.assets) || value.assets.length > SKILL_LIMITS.entries)
    throw new Error("Invalid skill asset manifest.");
  const rebuilt = await packageFrom(
    value.assets.map((a) => ({ path: a.path, bytes: skillBytes(a) })),
    value.source,
  );
  if (
    JSON.stringify(rebuilt.assets) !== JSON.stringify(value.assets) ||
    rebuilt.sha256 !== value.sha256 ||
    rebuilt.instructions !== value.instructions
  )
    throw new Error("The stored skill version failed its integrity check.");
  return rebuilt;
}
