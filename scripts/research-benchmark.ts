/** Portable Linux/Windows entrypoint; only synthetic fixtures and in-memory test secrets. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const output = resolve(
  process.env.FUSE_RESEARCH_BENCH_OUTPUT ?? "src-tauri/target/research-benchmark.json",
);
const started = performance.now();
mkdirSync(dirname(output), { recursive: true });
const core = join(dirname(output), "research-benchmark-core.json"),
  hulk = join(dirname(output), "research-benchmark-hulk.json");
const server = process.platform === "linux" && Boolean(process.env.FUSE_SERVER_BIN);
const run = spawnSync(
  process.execPath,
  [
    resolve("node_modules/vitest/vitest.mjs"),
    "run",
    "src/research/research.bench.test.ts",
    "src/research/research.hulk.bench.test.ts",
    "src/research/engine.test.ts",
    "src/research/storage.test.ts",
    "src/research/transfer.test.ts",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, FUSE_RESEARCH_BENCH_OUTPUT: core, FUSE_RESEARCH_HULK_OUTPUT: hulk },
  },
);
if (run.status !== 0) process.exit(run.status ?? 1);
const recorded = JSON.parse(readFileSync(core, "utf8")) as { results: unknown[] };
const hosted = server
  ? (JSON.parse(readFileSync(hulk, "utf8")) as { results: unknown[] })
  : { results: [] };
writeFileSync(
  output,
  JSON.stringify(
    {
      ...recorded,
      elapsedMs: Math.round(performance.now() - started),
      platform: process.platform,
      results: [...recorded.results, ...hosted.results],
      skipped: server
        ? []
        : [
            "HULK caller disconnection (Linux fixture server required)",
            "HULK hard runner exit (Linux fixture server required)",
          ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Recorded research benchmark: ${String(recorded.results.length + hosted.results.length)} scenarios; ${server ? "HULK included" : "HULK scenarios explicitly skipped"}. ${output}`,
);
