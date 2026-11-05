import path from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  ssr: { noExternal: true, target: "node" },
  publicDir: false,
  build: {
    ssr: "src/skills/testing/runner.ts",
    outDir: "src-tauri/target/skill-script-runner-fixture",
    emptyOutDir: true,
    target: "node24",
    rolldownOptions: {
      output: { entryFileNames: "skill-script-fixture.mjs", codeSplitting: false },
    },
  },
});
