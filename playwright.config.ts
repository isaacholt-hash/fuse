// M19.1: the shared web app in three browser engines against one throwaway native server
// (scripts/browsers-web.sh). Scripted replies only; no provider keys or calls.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/browsers",
  outputDir: "e2e/screenshots/browsers/results",
  // One server and one passphrase: the engines run one after another.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"], ["json", { outputFile: "e2e/screenshots/browsers/report.json" }]],
  use: {
    baseURL: process.env.FUSE_BROWSERS_URL ?? "http://127.0.0.1:4222/",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
  },
  projects: (process.env.FUSE_BROWSER_ENGINES ?? "chromium,firefox,webkit")
    .split(",")
    .map((name) => ({
      name,
      use: {
        ...(name === "firefox"
          ? devices["Desktop Firefox"]
          : name === "webkit"
            ? devices["Desktop Safari"]
            : devices["Desktop Chrome"]),
        viewport: { width: 1280, height: 900 },
      },
    })),
});
