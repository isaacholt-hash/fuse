import path from "node:path";
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * AR-05: React previews run React from the app's own bundle, inlined into the preview page
 * (its policy allows no network). This builds src/artifacts/previewRuntime.ts into one script
 * and serves it as `virtual:react-preview-runtime` (a string). Tests get a stub.
 */
function reactPreviewRuntime(): Plugin {
  const id = "virtual:react-preview-runtime";
  return {
    name: "fuse-react-preview-runtime",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    async load(source) {
      if (source !== `\0${id}`) return null;
      if (process.env.VITEST) return `export default "/* preview runtime stub */";`;
      const { build } = await import("vite");
      const result = await build({
        configFile: false,
        logLevel: "warn",
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        build: {
          write: false,
          minify: true,
          lib: {
            entry: path.resolve(import.meta.dirname, "src/artifacts/previewRuntime.ts"),
            formats: ["iife"],
            name: "FusePreviewRuntime",
          },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const first = outputs[0];
      if (!("output" in first)) throw new Error("preview runtime: no output");
      return `export default ${JSON.stringify(first.output[0].code)};`;
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), reactPreviewRuntime()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },

  // Tauri-specific: keep Rust errors visible, use a fixed port, don't watch src-tauri.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
