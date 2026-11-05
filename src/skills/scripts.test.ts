// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import { openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as t } from "@/storage/defaults";
import { createProject } from "@/storage/projects";
import { readSkillPackage } from "./package";
import { importSkill, deleteSkill } from "./storage";
import { selectedSkillScript } from "./scripts";

async function setup() {
  const db = openTestDb(),
    p = await createProject(db, t, "One");
  const a = await importSkill(db, t, {
    name: "calculate",
    projectId: p.id,
    localOnly: true,
    package: await readSkillPackage(
      "calc.zip",
      zipSync({
        "SKILL.md": strToU8("Run only when asked."),
        "calculate.py": strToU8("print('result')"),
        "data.txt": strToU8("42"),
      }),
    ),
  });
  const task = `/skill calculate@${a.versionId}\nCalculate`;
  const input = {
    version_id: a.versionId,
    path: "calculate.py",
    args: ["literal; $(no shell)", "日本語"],
    timeout_seconds: 30,
  };
  return { db, p, a, task, input };
}
test("approval contains immutable source, all inputs and resource bounds, without granting folders", async () => {
  const { db, p, task, input } = await setup();
  const { script, approval } = await selectedSkillScript(db, t, p.id, task, input);
  expect(script).toBe("print('result')");
  expect(approval.assets.map((a) => a.path)).toEqual(["SKILL.md", "calculate.py", "data.txt"]);
  expect(approval.args).toEqual(input.args);
  expect(approval.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(approval.packageSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(approval.timeoutSecs).toBe(30);
  expect(await db.select("SELECT * FROM folders")).toEqual([]);
});
test("malicious paths, arguments, non-Python, uninvoked and out-of-scope scripts are refused", async () => {
  const { db, p, task, input } = await setup();
  for (const change of [
    { path: "../calculate.py" },
    { path: "C:\\calculate.py" },
    { path: "data.txt" },
    { path: "missing.py" },
    { args: ["nul\0"] },
    { args: Array(33).fill("a") },
    { args: ["a".repeat(16385)] },
    { args: ["語".repeat(6000)] },
    { timeout_seconds: 121 },
    { timeout_seconds: 0 },
    { timeout_seconds: NaN },
    { timeout_seconds: 1.5 },
    { network: true },
  ])
    await expect(selectedSkillScript(db, t, p.id, task, { ...input, ...change })).rejects.toThrow();
  await expect(selectedSkillScript(db, t, p.id, "Quoted:\n" + task, input)).rejects.toThrow(
    /invoked/,
  );
  await expect(selectedSkillScript(db, t, null, task, input)).rejects.toThrow(/available/);
  await expect(
    selectedSkillScript(db, { ...t, userId: "other" }, p.id, task, input),
  ).rejects.toThrow(/available/);
});
test("deletion during approval cannot dispatch a stale pinned script", async () => {
  const { db, p, a, task, input } = await setup();
  await selectedSkillScript(db, t, p.id, task, input);
  await deleteSkill(db, t, a.skillId);
  await expect(selectedSkillScript(db, t, p.id, task, input)).rejects.toThrow(/available/);
  expect(await db.select("SELECT * FROM skill_script_claims")).toEqual([]);
});

test("output saves are bounded, snapshotted and folder-relative, with no duplicate destinations", async () => {
  const { db, p, task, input } = await setup();
  for (const keep of [
    Array(51).fill({ from: "out.txt", to: "out.txt" }),
    [{ from: "../out.txt", to: "out.txt" }],
    [{ from: "out.txt", to: "C:/escape.txt" }],
    [{ from: "out.txt", to: "../escape.txt" }],
    [{ from: "out.txt", to: "/escape.txt" }],
    [
      { from: "out.txt", to: "same.txt" },
      { from: "two.txt", to: "SAME.TXT" },
    ],
  ])
    await expect(selectedSkillScript(db, t, p.id, task, { ...input, keep })).rejects.toThrow();
  const keep = [{ from: "result.txt", to: "報告/result.txt" }];
  const selected = await selectedSkillScript(db, t, p.id, task, { ...input, keep });
  const mapping = keep[0];
  if (!mapping) throw new Error("Missing fixture mapping");
  mapping.to = "changed.txt";
  expect(selected.approval.outputs).toEqual([{ from: "result.txt", to: "報告/result.txt" }]);
});
