// @vitest-environment node
// Exercise the real workflow verifier with a synthetic GitHub API; failures must retain evidence.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/check-hulk-live-branch.sh", import.meta.url));
const file = "live-check/synthetic.md";
const line = "Synthetic handover.";

describe.skipIf(process.platform === "win32")(
  "live branch verification on the Linux workflow",
  () => {
    test.each([
      "valid",
      "multiple files",
      "wrong file",
      "wrong author",
      "wrong content",
      "no commit",
    ])("%s: delete only the verified synthetic result", (variant) => {
      const dir = mkdtempSync(join(tmpdir(), "fuse-live-verifier-"));
      try {
        writeFileSync(
          join(dir, "compare.json"),
          JSON.stringify({
            ahead_by: variant === "no commit" ? 0 : 1,
            files:
              variant === "multiple files"
                ? [
                    { filename: file, status: "added" },
                    { filename: "live-check/extra.md", status: "added" },
                  ]
                : [{ filename: variant === "wrong file" ? "other.md" : file, status: "added" }],
          }),
        );
        writeFileSync(
          join(dir, "commit.json"),
          JSON.stringify({
            sha: "synthetic-sha",
            commit: {
              author: { name: variant === "wrong author" ? "Other identity" : "FUSE Benchmark" },
            },
          }),
        );
        writeFileSync(
          join(dir, "content"),
          Buffer.from(variant === "wrong content" ? "Unexpected\n" : `${line}\n`).toString(
            "base64",
          ),
        );
        writeFileSync(
          join(dir, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *compare/*) cat "$FIXTURE/compare.json" ;;
  *commits/*) cat "$FIXTURE/commit.json" ;;
  *contents/*) cat "$FIXTURE/content" ;;
  'api -X DELETE '*) touch "$FIXTURE/deleted" ;;
  *) exit 77 ;;
esac
`,
          { mode: 0o700 },
        );
        const result = spawnSync("bash", [script], {
          encoding: "utf8",
          env: {
            PATH: `${dir}:/usr/bin:/bin`,
            FIXTURE: dir,
            GITHUB_REPOSITORY: "synthetic/fixture",
            BRANCH: "fuse/synthetic",
            BASE: "synthetic-base",
            EXPECTED_FILE: file,
            EXPECTED_LINE: line,
            EVIDENCE_FILE: join(dir, "evidence.json"),
            HULK_BUILD: "synthetic-server",
            HULK_SCHEMA: "61",
            TEST_DEVICE_ID: "synthetic-device",
            TEST_DEVICE_NAME: "Synthetic test device",
            REQUEST_ID: "synthetic-request",
          },
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(
          variant === "valid" ? 0 : 1,
        );
        expect(existsSync(join(dir, "deleted"))).toBe(variant === "valid");
        expect(existsSync(join(dir, "evidence.json"))).toBe(variant === "valid");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
