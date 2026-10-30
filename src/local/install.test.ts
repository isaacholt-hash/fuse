// @vitest-environment node
import { statusFor, usableProfile, type InstalledFile } from "./install";
import { localModels } from "./models";

const [big, small] = localModels.profiles;
if (!big || !small) throw new Error("expected two profiles");
const file = (p: typeof big, sha = p.sha256): InstalledFile => ({
  file: p.file,
  sha256: sha,
  revision: p.revision,
  sizeBytes: p.sizeBytes,
  installedMs: 1,
});

test("missing, installed, or out of date against the shipped checksum", () => {
  expect(statusFor(big, [])).toEqual({ kind: "missing" });
  expect(statusFor(big, [file(big)]).kind).toBe("installed");
  expect(statusFor(big, [file(big, "0".repeat(64))]).kind).toBe("update");
});

test("FUSE runs the largest profile installed with its current checksum", () => {
  expect(usableProfile([], localModels.profiles)).toBeNull();
  expect(usableProfile([file(small)], localModels.profiles)?.id).toBe("qwen3-1.7b");
  expect(usableProfile([file(small), file(big)], localModels.profiles)?.id).toBe("qwen3-4b");
  // An outdated big one isn't used; the small one is.
  expect(usableProfile([file(big, "f".repeat(64)), file(small)], localModels.profiles)?.id).toBe(
    "qwen3-1.7b",
  );
});
