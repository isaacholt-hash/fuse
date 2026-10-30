// @vitest-environment node
import { localModels } from "./models";
import { pickProfile, type Hardware } from "./hardware";

const GB = 1e9;
const hw = (over: Partial<Hardware> = {}): Hardware => ({
  os: "linux",
  arch: "x86_64",
  logicalCpus: 8,
  totalMemoryBytes: 16 * GB,
  availableMemoryBytes: 10 * GB,
  cpuSupported: true,
  freeDiskBytes: 100 * GB,
  ...over,
});
const pick = (over: Partial<Hardware> = {}) => pickProfile(hw(over), localModels.profiles);

test("the largest model that fits in 40% of RAM", () => {
  // 4B needs ~3.4 GB: fits from ~8.5 GB of RAM; 1.7B (~2.6 GB) from ~6.5 GB.
  expect(pick().profile?.id).toBe("qwen3-4b");
  expect(pick({ totalMemoryBytes: 14 * GB }).profile?.id).toBe("qwen3-4b");
  expect(pick({ totalMemoryBytes: 8 * GB }).profile?.id).toBe("qwen3-1.7b");
  expect(pick({ totalMemoryBytes: 8 * GB }).reason).toMatch(
    /Qwen3 4B \(local\) would need 3\.4 GB/,
  );
  const small = pick({ totalMemoryBytes: 4 * GB });
  expect(small.profile).toBeNull();
  expect(small.reason).toMatch(/needs about 2\.6 GB/);
});

test("no AVX2 or not x86-64: none, and why", () => {
  expect(pick({ cpuSupported: false })).toMatchObject({ profile: null, reason: /AVX2/ });
  expect(pick({ arch: "aarch64" })).toMatchObject({ profile: null, reason: /Intel or AMD/ });
});

test("disk: the file plus 1 GB spare; unknown free space doesn't block", () => {
  expect(pick({ freeDiskBytes: 3 * GB }).profile?.id).toBe("qwen3-1.7b");
  expect(pick({ freeDiskBytes: 2 * GB })).toMatchObject({ profile: null, reason: /free disk/ });
  expect(pick({ freeDiskBytes: null }).profile?.id).toBe("qwen3-4b");
});

test("a warning when less memory is free right now than the model needs", () => {
  expect(pick().warning).toBeNull();
  expect(pick({ availableMemoryBytes: 2 * GB }).warning).toMatch(/Only 2\.0 GB is free/);
});
