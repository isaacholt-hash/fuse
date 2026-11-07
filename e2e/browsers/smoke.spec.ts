/// <reference lib="dom" />
// M19.1: the shared web app's main P2 paths in Chromium, Firefox and WebKit, against the
// native server. Scripted replies only (fuse-e2e-scripted-build): no provider keys or calls.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHOTS = join(import.meta.dirname, "..", "screenshots", "browsers");
const PASS = "a synthetic browser matrix passphrase";

async function signIn(page: Page): Promise<number> {
  const started = Date.now();
  await page.goto("/");
  const setUp = page.getByRole("button", { name: "Set passphrase" });
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(setUp.or(signIn)).toBeVisible();
  const fields = page.locator('input[type="password"]');
  if (await setUp.isVisible()) {
    await fields.nth(0).fill(PASS);
    await fields.nth(1).fill(PASS);
    await setUp.click();
  } else {
    await fields.first().fill(PASS);
    await signIn.click();
  }
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  return Date.now() - started;
}

/** Fails on critical violations; serious ones are recorded for the acceptance report. */
async function scan(page: Page, name: string, engine: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const summary = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    // The measured colours and ratio, so a recorded finding can be checked without a rerun.
    details: v.nodes.slice(0, 5).map((n) => n.failureSummary ?? ""),
  }));
  writeFileSync(join(SHOTS, `${engine}-${name}-axe.json`), JSON.stringify(summary, null, 1));
  expect(result.violations.filter((v) => v.impact === "critical")).toEqual([]);
  return summary;
}

test("chat, writing canvas, reports and narrow layout work and pass the accessibility gate", async ({
  page,
  browserName,
}) => {
  mkdirSync(SHOTS, { recursive: true });
  const timings: Record<string, number> = {};
  timings.signInMs = await signIn(page);
  expect(await page.evaluate(() => document.documentElement.dataset.build)).toBe(
    "fuse-e2e-scripted-build",
  );

  // Keyboard: the composer is reachable and focusable without a mouse.
  await page.getByRole("textbox", { name: "Message" }).focus();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  const chatAxe = await scan(page, "chat", browserName);
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
  });
  // Colours transition on a theme change; scan the settled theme, not a frame mid-fade.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const darkAxe = await scan(page, "chat-dark", browserName);
  await page.screenshot({ path: join(SHOTS, `${browserName}-chat-dark.png`) });
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
  });

  // A Chat answer with a Markdown document opens the writing canvas.
  await page.getByRole("button", { name: "New chat" }).first().click();
  const sent = Date.now();
  await page.getByRole("textbox", { name: "Message" }).fill("E2E canvas draft");
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Artifact: Canvas plan" });
  await expect(panel.getByRole("group", { name: "Writing tools" })).toBeVisible();
  timings.answerToCanvasMs = Date.now() - sent;
  await page.screenshot({ path: join(SHOTS, `${browserName}-canvas.png`) });
  const canvasAxe = await scan(page, "canvas", browserName);

  // Settings → Provider usage reports, deep-linked.
  await page.evaluate(() => {
    window.location.hash = "#settings/costs-limits/provider-reports";
  });
  await expect(page.getByLabel("OpenAI admin key")).toBeVisible();
  await page.screenshot({ path: join(SHOTS, `${browserName}-reports.png`) });
  const settingsAxe = await scan(page, "settings", browserName);

  // Narrow layout: nothing scrolls sideways at phone width.
  await page.evaluate(() => {
    window.location.hash = "";
  });
  await page.setViewportSize({ width: 390, height: 844 });
  // On a phone the open canvas takes the whole width; closing it gives the chat back.
  const phonePanel = await panel.boundingBox();
  expect(phonePanel?.width).toBeGreaterThanOrEqual(388);
  await page.screenshot({ path: join(SHOTS, `${browserName}-narrow-canvas.png`) });
  await panel.getByRole("button", { name: "Close artifact" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  // Narrowing the window closes the sidebar, so the composer has the whole width (PL-01).
  await expect(page.getByRole("complementary", { name: /sidebar$/ })).toHaveCount(0);
  const composer = await page.getByRole("textbox", { name: "Message" }).boundingBox();
  expect(composer).not.toBeNull();
  expect((composer?.x ?? 0) + (composer?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(composer?.width ?? 0).toBeGreaterThan(300);
  await page.screenshot({ path: join(SHOTS, `${browserName}-narrow.png`) });
  // Opened on a phone, it covers the conversation without squeezing it, and picking a chat closes it.
  await page.getByRole("button", { name: "Show sidebar (Ctrl+B)" }).click();
  await expect(page.getByRole("complementary", { name: /sidebar$/ })).toBeVisible();
  const covered = await page.getByRole("textbox", { name: "Message" }).boundingBox();
  expect(covered?.width).toBe(composer?.width);
  await page.screenshot({ path: join(SHOTS, `${browserName}-narrow-sidebar.png`) });
  await page.getByRole("button", { name: "New chat" }).first().click();
  await expect(page.getByRole("complementary", { name: /sidebar$/ })).toHaveCount(0);
  // Widening again brings back the sidebar that narrowing closed (it was open at 1280).
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("complementary", { name: /sidebar$/ })).toBeVisible();

  writeFileSync(
    join(SHOTS, `${browserName}-result.json`),
    JSON.stringify(
      {
        engine: browserName,
        timings,
        axe: { chat: chatAxe, chatDark: darkAxe, canvas: canvasAxe, settings: settingsAxe },
        narrowOverflowPx: overflow,
      },
      null,
      1,
    ),
  );
});
