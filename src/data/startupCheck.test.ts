// @vitest-environment node
import { DEFAULT_TENANT } from "@/storage/defaults";
import { getSetting } from "@/storage/settings";
import { openTestDb } from "@/storage/testing/nodeDb";
import type { FileCheck } from "./backups";
import { startupCheck, startupNotice } from "./startupCheck";

const t = DEFAULT_TENANT;
const build = { schema: 55, builtFrom: "84b779b", builtOn: "2026-11-02" };
const fine = (): Promise<FileCheck> => Promise.resolve({ checked: 3, missing: [], changed: [] });

test("the first start on a build runs the checks and remembers the build; the next start skips them", async () => {
  const db = openTestDb();
  let checks = 0;
  const count = () => {
    checks++;
    return fine();
  };
  expect(await startupCheck(db, t, build, count)).toEqual({ updated: true, problems: [] });
  expect(await getSetting(db, t, "app.build")).toBe("84b779b@55");
  expect(await startupCheck(db, t, build, count)).toEqual({ updated: false, problems: [] });
  expect(checks).toBe(1);
  // A new build, even with the same schema, checks again.
  expect((await startupCheck(db, t, { ...build, builtFrom: "9f2d604" }, count)).updated).toBe(true);
  expect(checks).toBe(2);
});

test("missing or changed files, and broken keys, are named; nothing is said otherwise", async () => {
  const db = openTestDb();
  const broken = (): Promise<FileCheck> =>
    Promise.resolve({ checked: 3, missing: ["a".repeat(64)], changed: ["b".repeat(64)] });
  const first = await startupCheck(db, t, build, broken);
  expect(first.problems).toEqual(["Checked 3 attached files: 1 missing, 1 changed."]);
  expect(startupNotice(first)).toMatch(/^The check after the update found problems: Checked 3/);
  expect(startupNotice(first)).toMatch(/Settings → Your data\.$/);
  expect(startupNotice({ updated: true, problems: [] })).toBeNull();

  // A row pointing nowhere (keys are enforced, so it has to be planted with them off).
  db.raw.exec("PRAGMA foreign_keys = OFF");
  db.raw.exec(
    "INSERT INTO thread_tags (id, workspace_id, user_id, thread_id, tag, created_at, updated_at) VALUES ('x', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'gone', 'home', 1, 1)",
  );
  db.raw.exec("PRAGMA foreign_keys = ON");
  const next = await startupCheck(db, t, { ...build, builtFrom: "next" }, fine);
  expect(next.problems).toEqual(["1 rows point at records that no longer exist."]);
});
