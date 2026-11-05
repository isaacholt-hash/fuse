import path from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  ssr: { noExternal: true, target: "node" },
  publicDir: false,
  build: {
    ssr: "src/review/testing/runner.ts",
    outDir: "src-tauri/target/review-runner-fixture",
    emptyOutDir: true,
    target: "node24",
    rolldownOptions: { output: { entryFileNames: "review-fixture.mjs", codeSplitting: false } },
  },
});
