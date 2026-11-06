// @vitest-environment node
import { textAnchor } from "@/artifacts/sections";
import {
  acceptProposal,
  addComment,
  deleteComment,
  discardProposal,
  fillProposal,
  interruptProposal,
  listComments,
  listProposals,
  reattachComment,
  requestProposal,
  setCommentResolved,
  StaleProposalError,
} from "./artifactCanvas";
import { addVersion, listArtifacts, listVersions, saveArtifacts } from "./artifacts";
import { DEFAULT_TENANT as t } from "./defaults";
import { addMessage } from "./messages";
import { openTestDb } from "./testing/nodeDb";
import { createThread, purgeThread } from "./threads";

const DOC = "# Plan\n\nShip the canvas.\n\n## Risks\n\nConcurrent edits.\n";

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
    { key: "plan", title: "Plan", type: "markdown", language: "", content: DOC, complete: true },
  ]);
  const [artifact] = await listArtifacts(db, t, thread.id);
  if (!artifact) throw new Error("Missing fixture artifact");
  return { db, thread, message, artifact };
}

test("comments pin to an exact version passage, resolve, and never move without confirmation", async () => {
  const { db, artifact } = await fixture();
  const start = DOC.indexOf("Concurrent edits.");
  const anchor = textAnchor(artifact.versionId, DOC, start, start + "Concurrent edits.".length);
  const comment = await addComment(db, t, artifact.id, anchor, "  Name the worst case.  ");
  expect(comment.body).toBe("Name the worst case.");
  await expect(
    addComment(db, t, artifact.id, { ...anchor, quote: "Not in the document" }, "x"),
  ).rejects.toThrow("isn't in the saved version");
  await expect(addComment(db, t, artifact.id, anchor, "   ")).rejects.toThrow("Write a comment");

  await setCommentResolved(db, t, comment.id, true);
  expect((await listComments(db, t, artifact.id))[0]?.resolvedAt).not.toBeNull();
  await setCommentResolved(db, t, comment.id, false);

  // An edit above the passage moves it; the comment stays on its version until confirmed.
  await addVersion(db, t, artifact.id, `Intro line.\n${DOC}`, "user");
  const [kept] = await listComments(db, t, artifact.id);
  expect(kept?.versionId).toBe(artifact.versionId);
  const moved = await reattachComment(db, t, comment);
  expect(moved.start).toBe(start + "Intro line.\n".length);
  expect(moved.versionId).not.toBe(artifact.versionId);

  // A passage that no longer exists can't be reattached.
  await addVersion(db, t, artifact.id, "# Plan\n\nAll rewritten.\n", "user");
  await expect(reattachComment(db, t, moved)).rejects.toThrow("isn't in the latest version");

  await deleteComment(db, t, comment.id);
  expect(await listComments(db, t, artifact.id)).toEqual([]);
});

test("a proposal becomes a version only on accept, and only against its base", async () => {
  const { db, artifact, message } = await fixture();
  const id = await requestProposal(db, t, {
    artifactId: artifact.id,
    baseVersionId: artifact.versionId,
    start: 0,
    end: DOC.length,
    instruction: "Shorten",
  });
  expect((await listProposals(db, t, artifact.id))[0]?.state).toBe("requested");
  await expect(acceptProposal(db, t, id)).rejects.toThrow("no longer waiting");
  await fillProposal(db, t, id, message, "# Plan\n\nShip it.\n");
  expect(await listVersions(db, t, artifact.id)).toHaveLength(1);

  const versionId = await acceptProposal(db, t, id);
  const versions = await listVersions(db, t, artifact.id);
  expect(versions.map((v) => [v.id, v.source, v.content])).toEqual([
    [artifact.versionId, "model", DOC],
    [versionId, "model", "# Plan\n\nShip it.\n"],
  ]);
  expect(await listProposals(db, t, artifact.id)).toEqual([]);
  await expect(acceptProposal(db, t, id)).rejects.toThrow("no longer waiting");
});

test("a stale proposal is refused after a concurrent edit; discard and interruption stay inert", async () => {
  const { db, artifact, message } = await fixture();
  const stale = await requestProposal(db, t, {
    artifactId: artifact.id,
    baseVersionId: artifact.versionId,
    start: 0,
    end: 6,
    instruction: "Rewrite",
  });
  await fillProposal(db, t, stale, message, "# Better plan\n");
  await addVersion(db, t, artifact.id, `${DOC}\nMy edit.\n`, "user");
  await expect(acceptProposal(db, t, stale)).rejects.toBeInstanceOf(StaleProposalError);
  expect(await listVersions(db, t, artifact.id)).toHaveLength(2);
  await discardProposal(db, t, stale);

  const stopped = await requestProposal(db, t, {
    artifactId: artifact.id,
    baseVersionId: artifact.versionId,
    start: 0,
    end: 6,
    instruction: "Expand",
  });
  await interruptProposal(db, t, stopped);
  expect((await listProposals(db, t, artifact.id)).map((p) => [p.id, p.state])).toEqual([
    [stopped, "interrupted"],
  ]);
  // A late reply can't revive an interrupted request.
  await fillProposal(db, t, stopped, message, "late");
  expect((await listProposals(db, t, artifact.id))[0]?.content).toBeNull();
});

test("a manual save from an old version is refused and leaves the latest intact", async () => {
  const { db, artifact } = await fixture();
  await addVersion(db, t, artifact.id, `${DOC}\nTheirs.\n`, "user", null, artifact.versionId);
  await expect(
    addVersion(db, t, artifact.id, `${DOC}\nMine.\n`, "user", null, artifact.versionId),
  ).rejects.toThrow("Your draft is preserved");
  expect((await listVersions(db, t, artifact.id)).at(-1)?.content).toContain("Theirs.");
  // Saving unchanged content is a no-op, not a new version.
  const latest = (await listVersions(db, t, artifact.id)).at(-1);
  expect(await addVersion(db, t, artifact.id, latest?.content ?? "", "user")).toBe(2);
});

test("comments and proposals go with their conversation", async () => {
  const { db, thread, artifact, message } = await fixture();
  await addComment(db, t, artifact.id, textAnchor(artifact.versionId, DOC, 0, 6), "Title?");
  const id = await requestProposal(db, t, {
    artifactId: artifact.id,
    baseVersionId: artifact.versionId,
    start: 0,
    end: 6,
    instruction: "Rewrite",
  });
  await fillProposal(db, t, id, message, "# New\n");
  await purgeThread(db, t, thread.id);
  expect(await db.select("SELECT id FROM artifact_comments")).toEqual([]);
  expect(await db.select("SELECT id FROM artifact_proposals")).toEqual([]);
});
