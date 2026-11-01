// M10 steps 11 to 17: the test checklist from the build report, clicked through on the test build
// (scripted models, no keys; src/e2e/deps.ts). Run with app.e2e.ts by `pnpm e2e`: on CI's Windows
// runner for every PR, and on Isaac's PC after each release. Item 9, the live check on HULK,
// needs Isaac and is not here. Each step leaves a screenshot in e2e/screenshots/checklist/.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { button, byLabel, Session } from "./driver";

const APP = process.env.FUSE_E2E_APP ?? "";
const FOLDER = process.env.FUSE_E2E_FOLDER ?? "C:\\fuse-e2e";
const SHOTS = join(import.meta.dirname, "screenshots", "checklist");
const HELLO = "Hello from the FUSE test script.";
const PROJECT = "Checklist";
const composer = '//textarea[@aria-label="Message"]';

let app: Session;
let shot = 0;

async function step(name: string, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    const alerts = await app.run<string[]>(
      "return [...document.querySelectorAll('[role=alert]')].map((e) => e.innerText.trim()).filter(Boolean);",
    );
    for (const a of alerts) app.console.push(`after ${name}, alert: ${a}`);
    await app.screenshot(join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The answers on screen, newest last. */
const answers = () =>
  app.run<string[]>(
    "return [...document.querySelectorAll('[data-answer]')].map((e) => e.innerText);",
  );

/** Waits for answer number `before` (0-based) to finish with one of the scripted endings. */
async function nextAnswer(before: number, ms = 60_000): Promise<string> {
  const until = Date.now() + ms;
  for (;;) {
    const last = (await answers()).at(before);
    if (last && [HELLO, "Command result:", "wasn't offered"].some((s) => last.includes(s))) {
      return last;
    }
    if (Date.now() > until)
      throw new Error(`No answer ${String(before + 1)} after ${String(ms)} ms`);
    await sleep(250);
  }
}

/** A sidebar row by its title, and its state dot. */
const row = (title: string) =>
  `//nav[@aria-label="Conversations"]//button[.//span[normalize-space()=${JSON.stringify(title)}]]`;
const dot = (title: string, state: "Going" | "New result" | "Waiting for you") =>
  `${row(title)}//*[@role="img" and @aria-label="${state}"]`;

/**
 * Where to click to open a row: its title. The row's hover buttons sit over its middle, hidden
 * until hovered, so a click there would land on one of them.
 */
const rowTitle = (title: string) =>
  `${row(title)}//span[normalize-space()=${JSON.stringify(title)}]`;

/** The open row's title, or null on a new draft. */
const selectedTitle = () =>
  app.run<string | null>(
    `return document.querySelector('nav[aria-label="Conversations"] [aria-current="page"] .truncate')?.innerText ?? null;`,
  );
const sidebarText = () =>
  app.run<string>(
    `return document.querySelector('nav[aria-label="Conversations"]')?.innerText ?? "";`,
  );

/** Waits until the open row's title is set and stays put (chats are titled after an answer). */
async function settledTitle(): Promise<string> {
  const until = Date.now() + 20_000;
  let last = await selectedTitle();
  for (;;) {
    await sleep(1500);
    const now = await selectedTitle();
    if (now && now === last && now !== "New chat") return now;
    if (Date.now() > until) throw new Error(`The open chat's title never settled (${String(now)})`);
    last = now;
  }
}

/** A new Code session in the project, ready to type into. */
async function newSession() {
  await app.chord("n");
  await app.find("//*[@data-new-session]");
  await app.choose("Project or repository", PROJECT);
}

const send = async (text: string) => {
  await app.type(composer, text);
  await app.press("Enter");
};

beforeAll(async () => {
  expect(APP, "set FUSE_E2E_APP to the test build's fuse.exe").not.toBe("");
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  // The other test file's app may still be closing: Session.start waits for its port first.
  await Session.portFree();
  rmSync(FOLDER, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  mkdirSync(FOLDER, { recursive: true });
  writeFileSync(join(FOLDER, "greet.ts"), 'export const greet = () => "helo";\n');
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (base) {
      rmSync(join(base, "com.isaacholt.fuse.e2e"), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 500,
      });
    }
  }
  app = await Session.start(APP);
  await app.find(composer, 60_000);
  expect(await app.run<string>("return document.documentElement.dataset.build ?? '';")).toBe(
    "fuse-e2e-scripted-build",
  );
}, 120_000);

afterAll(() => {
  const started = app as Session | undefined;
  if (!started) return;
  writeFileSync(join(SHOTS, "console.log"), started.console.join("\n"));
  started.quit();
});

let chatTitle = "";

test("set up: a project linked to the test folder, stopping runs idle for 1 minute", async () => {
  await step("setup-project", async () => {
    await app.click(button("New project"));
    await app.type('//input[@placeholder="e.g. Kitchen renovation"]', PROJECT);
    await app.click(button("Create project"));
    await app.gone(button("Create project"));
    await app.click(button(`${PROJECT} settings`));
    await app.click('//button[normalize-space()="Link a folder…"]');
    expect(await app.text('//section[@aria-label="Project folders"]//code')).toContain("fuse-e2e");
    const idle = byLabel("Stop a run when nothing happens for (minutes)");
    await app.type(idle, "1");
    await app.click(button("Save"));
    await app.gone(button("Save"));
    // Saved: the settings show it when opened again.
    await app.click(button(`${PROJECT} settings`));
    await app.find(idle);
    expect(
      await app.run<string>(
        `return document.querySelector('[aria-label="Stop a run when nothing happens for (minutes)"]').value;`,
      ),
    ).toBe("1");
    await app.press("Escape");
    await app.gone(idle);
  });
});

test("2. a chat in the project offers Continue in Code for a change, and edits nothing", async () => {
  await step("chat-change", async () => {
    await app.chord("1");
    await app.click(button(`New chat in ${PROJECT}`));
    // Worded as a code change: the hint only follows messages routed as coding (or unsure).
    await send("Fix the bug in greet.ts");
    expect(await nextAnswer(0)).toContain(HELLO);
    await app.find(byLabel("Continue in Code"));
    // A chat reads files but never changes them: no change was asked for, and nothing moved.
    expect(
      await app.run<boolean>(`return !document.querySelector('[aria-label="Make this change?"]');`),
    ).toBe(true);
    expect(readdirSync(FOLDER)).toEqual(["greet.ts"]);
    expect(readFileSync(join(FOLDER, "greet.ts"), "utf8")).toBe(
      'export const greet = () => "helo";\n',
    );
    chatTitle = await settledTitle();
  });
  await step("continue-in-code", async () => {
    await app.click(
      `//*[@aria-label="Continue in Code"]//button[normalize-space()="Continue in Code"]`,
    );
    await app.find(
      '//*[@aria-label="Area"]//button[@aria-pressed="true" and normalize-space()="Code"]',
    );
    await app.find("//*[@data-new-session]");
    const brief = await app.run<string>(
      `return document.querySelector('textarea[aria-label="Message"]').value;`,
    );
    expect(brief).toContain("Continuing from the chat");
    expect(brief).toContain("Fix the bug in greet.ts");
  });
});

test("3. a Code session with a project and a cost cap runs, named after its task", async () => {
  await step("code-session", async () => {
    await app.clear(composer);
    await app.choose("Project or repository", PROJECT);
    await app.type(byLabel("Cost cap"), "0.50");
    await send("E2E edit checklist.txt");
    await app.click(
      '//*[@aria-label="Make this change?"]//button[normalize-space()="Allow"]',
      60_000,
    );
    expect(await nextAnswer(0)).toContain("Command result:");
    expect(readFileSync(join(FOLDER, "checklist.txt"), "utf8")).toBe("Made by the checklist.\n");
    // The Continue in Code brief was sent with the task: the composer doesn't fill up with it again.
    expect(
      await app.run<string>(
        `return document.querySelector('textarea[aria-label="Message"]').value;`,
      ),
    ).toBe("");
    await app.find(`${row("E2E edit checklist.txt")}[@aria-current="page"]`);
    expect(await app.text(byLabel("Spent of cap"))).toContain("of $0.50");
  });
});

test("4. the Files panel lists the changed file, and Undo takes it back", async () => {
  await step("files-panel", async () => {
    const files = '//aside[@aria-label="Session files"]';
    const open = await app.run<boolean>(
      `return document.querySelector('[aria-label="Session files"]') !== null;`,
    );
    if (!open)
      await app.click(
        '//*[@aria-label="Session"]//button[starts-with(normalize-space(), "Files")]',
      );
    expect(await app.text(files)).toContain("checklist.txt");
    await app.click(`${files}//button[starts-with(@aria-label, "Undo ")]`);
    const until = Date.now() + 15_000;
    while (existsSync(join(FOLDER, "checklist.txt"))) {
      if (Date.now() > until) throw new Error("Undo left checklist.txt in the folder");
      await sleep(250);
    }
    await app.gone(`${files}//button[starts-with(@aria-label, "Undo ")]`);
  });
});

test("5. a run going in another session shows Going, then New, cleared on opening", async () => {
  await step("dots", async () => {
    await newSession();
    await send("E2E slow run");
    await app.find(row("E2E slow run"));
    // Look at another session while it runs.
    await app.click(rowTitle("E2E edit checklist.txt"));
    await app.find(dot("E2E slow run", "Going"), 10_000);
    await app.find(dot("E2E slow run", "New result"), 60_000);
    await app.find('//*[@aria-label="Filter by state"]//button[normalize-space()="New 1"]');
    await app.click(rowTitle("E2E slow run"));
    await app.gone(dot("E2E slow run", "New result"));
  });
});

test("1. Ctrl+1 and Ctrl+2: each area keeps its own list and reopens where you left it", async () => {
  await step("areas", async () => {
    await app.chord("1");
    await app.find(
      '//*[@aria-label="Area"]//button[@aria-pressed="true" and normalize-space()="Chat"]',
    );
    await app.find(`${row(chatTitle)}[@aria-current="page"]`);
    expect(await sidebarText()).not.toContain("E2E edit checklist.txt");
    await app.chord("2");
    await app.find(`${row("E2E slow run")}[@aria-current="page"]`);
    const code = await sidebarText();
    expect(code).toContain("E2E edit checklist.txt");
    expect(code).not.toContain(chatTitle);
  });
});

test("6. with a 1-minute idle limit, a stalled run stops and says why", async () => {
  await step("watchdog", async () => {
    await newSession();
    await send("E2E stall");
    await app.find(dot("E2E stall", "Going"), 15_000);
    // The watchdog looks every 15 s, so it stops between 60 and 75 s without progress.
    await app.sees("Stopped: no progress for", 120_000);
    await app.gone(dot("E2E stall", "Going"));
  });
}, 180_000);

test("7. the Scheduled page opens, and says why it's empty when not paired with HULK", async () => {
  await step("scheduled", async () => {
    await app.click('//button[normalize-space()="Scheduled"]');
    await app.sees("Scheduled tasks");
    await app.sees("Pair this computer with HULK in Settings to see them here.");
    await app.click(button("Back to sessions"));
    await app.find(composer);
  });
});

test("8. Usage shows spend by area and by where it ran", async () => {
  await step("usage", async () => {
    await app.click('//button[normalize-space()="Usage"]');
    const area = await app.text(byLabel("By area"));
    expect(area).toContain("Chat");
    expect(area).toContain("Code");
    expect(await app.text(byLabel("By where it ran"))).toContain("Desktop app");
  });
});
