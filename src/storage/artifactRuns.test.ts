// @vitest-environment node
import { finishRun, listRuns, refuseRun, requestRun, runnable, sha256Hex } from "./artifactRuns";
import { addVersion, listArtifacts, saveArtifacts } from "./artifacts";
import { DEFAULT_TENANT as t } from "./defaults";
import { addMessage } from "./messages";
import { openTestDb } from "./testing/nodeDb";
import { createThread, purgeThread } from "./threads";

const SOURCE = "print(sum([1, 2]))";

async function fixture() {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const message = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    content: "x",
  });
  await saveArtifacts(db, t, thread.id, message, [
    { key: "sum", title: "Sum", type: "code", language: "python", content: SOURCE, complete: true },
  ]);
  const [artifact] = await listArtifacts(db, t, thread.id);
  if (!artifact) throw new Error("Missing fixture artifact");
  return { db, thread, artifact };
}

test("only Python code artifacts are runnable", () => {
  expect(runnable({ type: "code", language: "Python" })).toBe(true);
  expect(runnable({ type: "code", language: "py" })).toBe(true);
  expect(runnable({ type: "code", language: "ts" })).toBe(false);
  expect(runnable({ type: "markdown", language: "python" })).toBe(false);
});

test("each approval is a numbered attempt on its exact version with its input hashes", async () => {
  const { db, artifact, thread } = await fixture();
  const sha = await sha256Hex(SOURCE);
  expect(sha).toHaveLength(64);
  const input = { name: "data.csv", sha256: "a".repeat(64), bytes: 8 };
  const first = await requestRun(db, t, {
    artifactId: artifact.id,
    versionId: artifact.versionId,
    scriptSha256: sha,
    inputs: [input],
  });
  expect(first).toMatchObject({
    attempt: 1,
    state: "requested",
    versionId: artifact.versionId,
    inputs: [input],
  });
  // The native side claims and finishes; the app stores what it printed and produced.
  await db.execute("UPDATE artifact_runs SET state='complete',exit_code=0 WHERE id=?", [first.id]);
  await finishRun(db, t, first.id, {
    output: "3\n",
    outputs: [{ path: "chart.png", sha256: "b".repeat(64), bytes: 120 }],
    exitCode: 0,
    timedOut: false,
    stopped: false,
    truncated: false,
    elapsedMs: 40,
  });
  const second = await requestRun(db, t, {
    artifactId: artifact.id,
    versionId: artifact.versionId,
    scriptSha256: sha,
    inputs: [],
  });
  expect(second.attempt).toBe(2);
  await refuseRun(db, t, second.id, "Python isn't installed here.");

  // A new version starts its own attempts.
  await addVersion(db, t, artifact.id, "print(4)", "user");
  const [latest] = (await listArtifacts(db, t, thread.id)).filter((a) => a.id === artifact.id);
  const third = await requestRun(db, t, {
    artifactId: artifact.id,
    versionId: latest?.versionId ?? "",
    scriptSha256: await sha256Hex("print(4)"),
    inputs: [],
  });
  expect(third.attempt).toBe(1);

  const runs = await listRuns(db, t, artifact.id);
  expect(runs.map((r) => [r.id, r.state])).toEqual([
    [third.id, "requested"],
    [second.id, "failed"],
    [first.id, "complete"],
  ]);
  expect(runs[1]?.output).toBe("Python isn't installed here.");
  expect(runs[2]).toMatchObject({ output: "3\n", exitCode: 0, elapsedMs: 40 });
  expect(runs[2]?.outputs[0]?.path).toBe("chart.png");
});

test("stopped runs say so, stale ones are interrupted, duplicates are refused, all go with the chat", async () => {
  const { db, artifact, thread } = await fixture();
  const sha = await sha256Hex(SOURCE);
  await expect(
    requestRun(db, t, {
      artifactId: artifact.id,
      versionId: artifact.versionId,
      scriptSha256: sha,
      inputs: [
        { name: "a.csv", sha256: "a".repeat(64), bytes: 1 },
        { name: "A.csv", sha256: "b".repeat(64), bytes: 1 },
      ],
    }),
  ).rejects.toThrow("different names");
  const run = await requestRun(db, t, {
    artifactId: artifact.id,
    versionId: artifact.versionId,
    scriptSha256: sha,
    inputs: [],
  });
  await db.execute("UPDATE artifact_runs SET state='failed' WHERE id=?", [run.id]);
  await finishRun(db, t, run.id, {
    output: "",
    outputs: [],
    exitCode: null,
    timedOut: false,
    stopped: true,
    truncated: false,
    elapsedMs: 10,
  });
  expect((await listRuns(db, t, artifact.id))[0]?.state).toBe("stopped");

  const stale = await requestRun(db, t, {
    artifactId: artifact.id,
    versionId: artifact.versionId,
    scriptSha256: sha,
    inputs: [],
  });
  await db.execute("UPDATE artifact_runs SET state='running',updated_at=1 WHERE id=?", [stale.id]);
  expect((await listRuns(db, t, artifact.id))[0]?.state).toBe("interrupted");

  await purgeThread(db, t, thread.id);
  expect(await db.select("SELECT id FROM artifact_runs")).toEqual([]);
});
