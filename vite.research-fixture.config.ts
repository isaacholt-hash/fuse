// A separate test entrypoint, never part of dist-runner or a release artifact.
import path from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  ssr: { noExternal: true, target: "node" },
  publicDir: false,
  build: {
    ssr: "src/research/testing/runner.ts",
    outDir: "src-tauri/target/research-runner-fixture",
    emptyOutDir: true,
    target: "node24",
    rolldownOptions: { output: { entryFileNames: "research-fixture.mjs", codeSplitting: false } },
  },
});
