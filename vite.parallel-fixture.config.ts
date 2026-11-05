import path from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  ssr: { noExternal: true, target: "node" },
  publicDir: false,
  build: {
    ssr: "src/parallel/testing/runner.ts",
    outDir: "src-tauri/target/parallel-runner-fixture",
    emptyOutDir: true,
    target: "node24",
    rolldownOptions: { output: { entryFileNames: "parallel-fixture.mjs", codeSplitting: false } },
  },
});
