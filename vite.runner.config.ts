// The runner's build (M10 step 6): src/runner/main.ts and everything it imports, bundled into
// one Node file, dist-runner/runner.mjs, so the server needs no node_modules to start it.
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  ssr: { noExternal: true, target: "node" },
  publicDir: false,
  build: {
    ssr: "src/runner/main.ts",
    outDir: "dist-runner",
    emptyOutDir: true,
    target: "node24",
    rollupOptions: { output: { entryFileNames: "runner.mjs", inlineDynamicImports: true } },
  },
});
