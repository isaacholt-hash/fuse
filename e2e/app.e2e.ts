// M8 step 14: FUSE driven like a person would use it, through tauri-driver, on the test build
// (scripted models, fake keys and update; src/e2e/deps.ts). Run by CI on Windows: see
// e2e/README.md. Each step leaves a screenshot in e2e/screenshots/.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, version } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { button, byLabel, KEY, Session } from "./driver";

const APP = process.env.FUSE_E2E_APP ?? "";
const NATIVE = process.env.FUSE_E2E_NATIVE_DRIVER;
const FOLDER = process.env.FUSE_E2E_FOLDER ?? "C:\\fuse-e2e";
const BASE = "http://127.0.0.1:4444";
const SHOTS = join(import.meta.dirname, "screenshots");
const HELLO = "Hello from the FUSE test script.";
// Windows Server (GitHub's runners) denies the NUL device to sandboxed apps; 10 and 11 don't.
const SERVER = /Server/i.test(version());

let driver: ChildProcess;
let app: Session;
let shot = 0;

async function step(name: string, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    await app.screenshot(join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`));
  }
}

/** The answers on screen, newest last. */
const answers = () =>
  app.run<string[]>(
    "return [...document.querySelectorAll('[data-answer]')].map((e) => e.innerText);",
  );

async function nextAnswer(before: number): Promise<string> {
  const until = Date.now() + 60_000;
  for (;;) {
    const all = await answers();
    const last = all.at(before);
    if (last?.includes("Command result:") || last?.includes(HELLO)) return last;
    if (Date.now() > until) throw new Error(`No new answer; the page has ${String(all.length)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const composer = '//textarea[@aria-label="Message"]';

beforeAll(async () => {
  expect(APP, "set FUSE_E2E_APP to the test build's fuse.exe").not.toBe("");
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  rmSync(FOLDER, { recursive: true, force: true });
  mkdirSync(FOLDER, { recursive: true });
  driver = spawn(
    process.env.FUSE_E2E_DRIVER ?? "tauri-driver",
    NATIVE ? ["--native-driver", NATIVE] : [],
    { stdio: "inherit" },
  );
  const until = Date.now() + 30_000;
  while (
    !(await fetch(`${BASE}/status`).then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    if (Date.now() > until) throw new Error("tauri-driver didn't start");
    await new Promise((r) => setTimeout(r, 250));
  }
  app = await Session.start(BASE, APP);
  await app.find(composer, 60_000);
  // Never drive a real build: only the test build has scripted models.
  expect(await app.run<string>("return document.documentElement.dataset.build ?? '';")).toBe(
    "fuse-e2e-scripted-build",
  );
}, 120_000);

afterAll(async () => {
  await app.quit().catch(() => undefined);
  driver.kill();
});

test("send a message and see its cost", async () => {
  await step("message", async () => {
    await app.type(composer, `Say hello${KEY.enter}`);
    expect(await nextAnswer(0)).toContain(HELLO);
    await app.find('//*[starts-with(@aria-label, "Cost breakdown for")]');
  });
});

test("switch models", async () => {
  await step("switch-model", async () => {
    await app.chord("k");
    await app.click('//button[contains(normalize-space(), "Claude Opus 5.5")]');
    await app.type(composer, `Again${KEY.enter}`);
    expect(await nextAnswer(1)).toContain(HELLO);
    await app.sees("Switched to Claude Opus 5.5");
  });
});

test("the update bar shows, and Later hides it (M7 F1)", async () => {
  await step("update-bar", async () => {
    expect(await app.text(byLabel("App update"))).toContain("FUSE 9.9.9 is ready");
    await app.click(button("Later"));
    await app.gone(byLabel("App update"));
  });
});

test("open Settings", async () => {
  await step("settings", async () => {
    await app.chord(",");
    await app.find('//h1[normalize-space()="Settings"] | //h2[normalize-space()="Settings"]');
    await app.find('//*[normalize-space()="Run commands in the sandbox"]');
    await app.chord(",");
    await app.find(composer);
  });
});

test("a Work run on a test folder: step 9's checks 2, 3 and 5", async () => {
  const escape = join(homedir(), "Documents", "escape.txt");
  rmSync(escape, { force: true });
  await step("work-setup", async () => {
    await app.chord("n");
    await app.click(button("Add a folder"));
    await app.sees("fuse-e2e");
    await app.click(button("Work run"));
  });
  const check = async (n: number, seen: number) => {
    await app.type(composer, `E2E check ${String(n)}${KEY.enter}`);
    await app.click(
      '//*[@aria-label="Run this command?"]//button[normalize-space()="Allow"]',
      60_000,
    );
    return nextAnswer(seen);
  };
  await step("check-2-inside", async () => {
    const out = await check(2, 0);
    expect(out).toContain("[sandboxed, network off]");
    expect(out).toContain("exit code 0");
    expect(readFileSync(join(FOLDER, "inside.txt"), "utf8").trim()).toBe("hi");
  });
  await step("check-3-outside", async () => {
    const out = await check(3, 1);
    expect(out).toContain("Access is denied");
    expect(existsSync(escape)).toBe(false);
  });
  if (SERVER) {
    console.log("Check 5 skipped: Windows Server denies NUL to sandboxed apps.");
    return;
  }
  await step("check-5-nul", async () => {
    const out = await check(5, 2);
    expect(out).toContain("shown");
    expect(out).toContain("exit code 0");
  });
}, 300_000);
