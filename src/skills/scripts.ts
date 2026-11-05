import type { ToolSpec } from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import type { SqlDb } from "@/storage/sql";
import { skillCommands } from "./invoke";
import { skillBytes, skillPath, skillText } from "./package";
import { getSkillVersion } from "./storage";

export interface SkillScriptApproval {
  name: string;
  versionId: string;
  packageSha256: string;
  scriptSha256: string;
  path: string;
  args: string[];
  assets: { path: string; bytes: number; sha256: string }[];
  timeoutSecs: number;
  outputs: { from: string; to: string }[];
}
export const RUN_SKILL_TOOL: ToolSpec = {
  name: "run_skill_script",
  description:
    "Run a selected Python .py file from an explicitly invoked immutable skill version, only after approval. Reads package assets only, with no host folders or network. Save outputs under os.environ['FUSE_OUT']; bounded console output, image previews and a file inventory return. List keep mappings to save selected output files through FUSE after explicit approval, with undo. The script never writes project files itself. Does not install packages or grant permissions. At most 120 seconds.",
  schema: {
    type: "object",
    properties: {
      version_id: { type: "string" },
      path: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      timeout_seconds: { type: ["number", "null"] },
      keep: {
        type: ["array", "null"],
        items: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
          additionalProperties: false,
        },
      },
    },
    required: ["version_id", "path", "args", "timeout_seconds", "keep"],
    additionalProperties: false,
  },
};
function outputKeeps(value: unknown): { from: string; to: string }[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50)
    throw new Error("Select at most 50 output files to save.");
  const seen = new Set<string>();
  return value.map((v: unknown) => {
    if (
      !v ||
      typeof v !== "object" ||
      !("from" in v) ||
      !("to" in v) ||
      typeof v.from !== "string" ||
      typeof v.to !== "string" ||
      Object.keys(v).some((k) => !["from", "to"].includes(k)) ||
      !v.to ||
      new TextEncoder().encode(v.to).length > 4096 ||
      v.to.includes("\0") ||
      /^(?:[/\\]|[A-Za-z]:)/.test(v.to) ||
      v.to.split(/[/\\]/).some((p) => !p || p === ".." || p === ".")
    )
      throw new Error("Choose a package-output name and an existing folder-relative destination.");
    const destination = v.to.replace(/\\/g, "/").normalize("NFC").toLowerCase();
    if (seen.has(destination)) throw new Error("Output destinations must be distinct.");
    seen.add(destination);
    return { from: skillPath(v.from), to: v.to };
  });
}

export async function selectedSkillScript(
  db: SqlDb,
  tenant: Tenant,
  projectId: string | null,
  task: string,
  input: Record<string, unknown>,
) {
  if (
    typeof input.version_id !== "string" ||
    typeof input.path !== "string" ||
    !Array.isArray(input.args) ||
    input.args.some((a: unknown) => typeof a !== "string" || a.includes("\0")) ||
    input.args.length > 32 ||
    new TextEncoder().encode(input.args.join("")).length > 16384 ||
    Object.keys(input).some(
      (k) => !["version_id", "path", "args", "timeout_seconds", "keep"].includes(k),
    )
  )
    throw new Error("Specify a pinned script and at most 32 bounded arguments.");
  const keep = outputKeeps(input.keep);
  const timeoutSecs = input.timeout_seconds ?? 120;
  if (
    typeof timeoutSecs !== "number" ||
    !Number.isInteger(timeoutSecs) ||
    timeoutSecs < 1 ||
    timeoutSecs > 120
  )
    throw new Error("Skill scripts run for 1–120 seconds.");
  const invoked = skillCommands(task).find((c) => c.versionId === input.version_id);
  if (!invoked) throw new Error("That skill wasn't explicitly invoked for this request.");
  const pkg = await getSkillVersion(db, tenant, input.version_id, projectId);
  if (pkg.name !== invoked.name) throw new Error("The skill name changed.");
  const path = skillPath(input.path),
    asset = pkg.assets.find((a) => a.path === path);
  if (!path.endsWith(".py") || !asset)
    throw new Error("Select a Python .py file in the invoked version.");
  const script = skillText(skillBytes(asset));
  const approval: SkillScriptApproval = {
    name: pkg.name,
    versionId: input.version_id,
    packageSha256: pkg.sha256,
    scriptSha256: asset.sha256,
    path,
    args: (input.args as string[]).slice(),
    assets: pkg.assets.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    timeoutSecs,
    outputs: keep.map((k) => ({ ...k })),
  };
  return { script, approval, keep };
}
