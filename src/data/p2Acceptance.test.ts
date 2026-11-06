// @vitest-environment node
// M19.1: the P2 tables keep their classifications end to end: portable records survive
// export → wipe → restore, owner-local execution and report state never travels, and
// delete-all leaves nothing behind.
import { textAnchor } from "@/artifacts/sections";
import { memoryFilesApi } from "@/files/api";
import { addComment, fillProposal, requestProposal } from "@/storage/artifactCanvas";
import { requestRun, sha256Hex } from "@/storage/artifactRuns";
import { listArtifacts, saveArtifacts } from "@/storage/artifacts";
import { DEFAULT_TENANT as t } from "@/storage/defaults";
import { addMessage } from "@/storage/messages";
import { queueMessage } from "@/storage/offlineQueue";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { importUsageCsv } from "@/storage/usageReports";
import registry from "../../data/sync.json";
import { deleteAllData } from "./deleteAll";
import { EXPORTED_TABLES, exportAll } from "./exportAll";
import { applyRestore, readFuseExport } from "./restore";

const LOCAL = [
  "artifact_proposals",
  "artifact_runs",
  "offline_queue",
  "usage_report_rows",
  "usage_report_runs",
] as const;

async function populated() {
  const db = openTestDb();
  const files = memoryFilesApi();
  const thread = await createThread(db, t, "P2 acceptance");
  const message = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    content: "x",
  });
  const doc = "# Plan\n\nShip P2.\n";
  await saveArtifacts(db, t, thread.id, message, [
    { key: "plan", title: "Plan", type: "markdown", language: "", content: doc, complete: true },
    {
      key: "sum",
      title: "Sum",
      type: "code",
      language: "python",
      content: "print(1)",
      complete: true,
    },
  ]);
  const [plan, sum] = ["plan", "sum"].map((k) => {
    return listArtifacts(db, t, thread.id).then((all) => all.find((a) => a.key === k));
  });
  const p = await plan;
  const s = await sum;
  if (!p || !s) throw new Error("Missing fixtures");
  await addComment(db, t, p.id, textAnchor(p.versionId, doc, 9, 16), "Which date?");
  const proposal = await requestProposal(db, t, {
    artifactId: p.id,
    baseVersionId: p.versionId,
    start: 0,
    end: doc.length,
    instruction: "Shorten",
  });
  await fillProposal(db, t, proposal, message, "# Plan\n");
  await requestRun(db, t, {
    artifactId: s.id,
    versionId: s.versionId,
    scriptSha256: await sha256Hex("print(1)"),
    inputs: [],
  });
  await queueMessage(db, t, { threadId: thread.id, text: "Later", effort: null, origin: "this" });
  await importUsageCsv(
    db,
    t,
    "source,date_utc,provider,kind,scope,key_id,model,line_item,currency,amount,input_tokens,output_tokens,cached_tokens,requests\ncsv,2026-11-05,openai,cost,,,,,usd,1,,,,",
  );
  return { db, files };
}

const count = async (db: ReturnType<typeof openTestDb>, table: string) =>
  (await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ?? 0;

test("P2 tables are classified: portable, owner-local or internal, never unlisted", () => {
  expect(Object.keys(registry.tables)).toContain("artifact_comments");
  for (const table of LOCAL) {
    expect(registry.localTables).toHaveProperty(table);
    expect(EXPORTED_TABLES as readonly string[]).not.toContain(table);
  }
  expect(EXPORTED_TABLES as readonly string[]).toContain("artifact_comments");
});

test("export → wipe → restore brings back portable P2 records and none of the local state", async () => {
  const { db, files } = await populated();
  for (const table of ["artifact_comments", ...LOCAL]) expect(await count(db, table)).toBe(1);
  const exported = await exportAll(db, t, files);
  await deleteAllData(db, t, files);
  for (const table of ["artifact_comments", "artifact_versions", ...LOCAL])
    expect(await count(db, table)).toBe(0);

  await applyRestore(db, t, await readFuseExport(exported.bytes), files);
  expect(await count(db, "artifact_comments")).toBe(1);
  expect(await count(db, "artifact_versions")).toBe(2);
  // Nothing that could execute, send or stand in for spend comes back from a restore.
  for (const table of LOCAL) expect(await count(db, table)).toBe(0);
  expect(await db.select("SELECT body FROM artifact_comments")).toEqual([{ body: "Which date?" }]);
});
