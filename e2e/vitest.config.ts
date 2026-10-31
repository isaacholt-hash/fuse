// The click-through tests (M8 step 14): `pnpm e2e`, against a running test build. Not part of
// `pnpm test`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
