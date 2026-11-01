<!-- Written 2026-11-01 from the approved plan. The step texts are in M10-runs-on-hulk.md; this file is how they get built. -->

# Plan: M10 steps 11 to 17, built unattended after Isaac's live check

## Context

Isaac approved the UI review's recommendation on 2026-11-01: FUSE gets two areas, Chat and Code, with Work sessions inside Code, the same on desktop and web. PR #223 queued that work as M10 steps 11 to 22 in his order. He then asked to plan the next build and have it run without him, with two answers given during planning:

- **Start:** only after his HULK deploy and live check. Anything the live check finds becomes an F-item he places in the queue; the run builds it when it reaches it.
- **Stop:** after step 17, so he can look at the new shell before the six review fixes (18 to 22).

So this plan covers seven PRs: 11 (stall watchdog), 12 (area switch), 13 (status and place), 14 (home screen), 15 (Scheduled page), 16 (composers), 17 (handoff and rollups). Each step ships on desktop and web and is checked on both (rule added to M10 in #223).

Three facts from the code map shape the design:

- Threads have no kind today; only `runs.kind` (code|work, migration 0041) does. The composer's Code/Work toggle is React state that is never saved.
- "Waiting for you" is in-memory on the desktop (`approvals` Map, `ChatApp.tsx:2586`) and the `run_approvals` table on the web. Where a run executes is not stored: the desktop knows handovers only from localStorage `fuse.handovers`; on the web everything runs on HULK.
- There is no per-project cost cap; every run uses `DEFAULT_RUN_CAP_MICRO_USD` (`src/agent/run.ts:90`). Browsers reserve Ctrl+1 and Ctrl+2 for tabs.

## How the run works (same as M2 to M10)

- One branch and PR per step (`m10/<name>`), in order 11, 12, 13, 14, 15, 16, 17. Before each step: `git pull`, scan the milestone for any unchecked item including F-items, and read the files the step names on main.
- Before each PR: `bash scripts/check.sh`, `cargo fmt --check`, `cargo clippy -- -D warnings` (with and without `--features server` when Rust changed), `cargo test`; a desktop screenshot with `scripts/screenshot.sh` and a web screenshot with `scripts/web-screenshot.py` against a `fuse-server --ui dist-web --home <tmp>` built with `--features server` (recipe from PR #205); the secret scan. The PR body says how both were checked.
- Merge only when `scripts/ci-green.sh <n>` exits 0; `gh pr merge --merge --delete-branch`; straight on to the next step. Tick the step's box in the same PR.
- Decisions a step needs are taken with the recommended option below, said in the PR, and listed in the final report. Stop only for keys, a check that won't go green, or anything destructive.
- After step 17: one combined report with the PR list, the decisions taken, what was not verified live, and a test checklist for Isaac.

## Migrations (three, forward-only, never edited after shipping)

| File | Step | Adds |
| --- | --- | --- |
| `0052_run_limits.sql` | 11 | `projects.run_cap_micro_usd INTEGER` (null = default), `projects.run_wall_minutes INTEGER` (null = 120), `projects.run_idle_minutes INTEGER` (null = 15); `runs.waited_ms INTEGER NOT NULL DEFAULT 0` |
| `0053_thread_kind.sql` | 12 | `threads.kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','code','work'))`, backfilled with the kind of the thread's latest run (`ORDER BY created_at DESC, id DESC LIMIT 1`) where one exists; `threads.seen_at INTEGER` (step 13); `threads.schedule_id TEXT` (step 15); `threads.handoff_from_id TEXT` (step 17); session settings for step 16, all nullable so null means the project's or the app's default: `run_mode TEXT CHECK (plan|ask|auto_edit)`, `run_branch INTEGER CHECK (0|1)`, `run_where TEXT CHECK (local|hulk)`, `run_cap_micro_usd INTEGER`. One migration for steps 12 to 17 because every column is nullable and designed now, and per-thread composer settings already live on `threads` (`web_search`, `instructions`, `pinned_*`, `stay_provider`) |
| `0054_request_surface.sql` | 17 | `request_log.surface TEXT` ('desktop', 'web', 'runner', 'scheduled') |

Each goes in `src-tauri/migrations/`, the `MIGRATIONS` list at `src-tauri/src/db.rs:289-293`, `docs/data-model.md`, and must keep `upgrading_a_seeded_database_keeps_every_row` (`db.rs:1047`) green; TS tests pick the file up through `src/storage/testing/nodeDb.ts`.

## Step 11. Stall watchdog for runs

**Limits.** Per project: wall-clock minutes (default 120), no-progress minutes (default 15), cost cap (default $1, the existing constant). Stored in the 0052 columns; read by `startRun` (`run.ts:~1381`) next to where the cap is applied today. Edited in `src/ui/ProjectRepo.tsx:116-160` beside the run mode, three number fields with their defaults shown as placeholders. Schedules keep their own cap (`runner.ts:149`).

**Loop.** A `Watchdog` in `src/agent/watchdog.ts`: `start({wallMs, idleMs, onStop})`, `progress()`, `waiting(on: boolean)`, `stop()`. It runs a 15-second interval; `progress()` is called from `progress()` in `run.ts:392-407` (every delta and step) and after each approval answer; `waiting(true/false)` wraps `askApproval` (`run.ts:645-668`) so time spent "Waiting for you" counts toward neither limit and accumulates into `runs.waited_ms`. On a trip it marks the run `stopped` with a note ("Stopped: no progress for 15 min" or "Stopped: ran for 2 h") and aborts an internal `AbortController` chained to `input.signal`, so a stream or command in flight ends too (`run.ts:523` already honours the signal). The between-turn checks at `run.ts:426-440` stay as the cheap path.

**Stop always works.** Web: in `Runner.handle` (`src/runner/runner.ts:176-179`), when a stop request names a run not in `going`, set its status to `stopped` in the database with the note "Stopped from another session". Desktop: `stop()` (`ChatApp.tsx:2324`) takes a run id; when there is no controller for it (after a restart) it writes the status directly. The card's Stop targets its own run, not only the selected thread.

**Display.** `runView.ts:246-290` adds `runningFor` ("Running for 1 h 20 m", from `created_at`, `updated_at` and `waited_ms`) shown on the `RunCard` header and in `src/ui/Runs.tsx:25` rows while the run is going; stopped-by-watchdog runs show the note like other stops.

**Tests.** `src/agent/watchdog.test.ts` with fake timers (idle trip, wall trip, waiting excluded, progress resets); `src/agent/run.test.ts` case where a fake adapter streams nothing for longer than idle and the run ends `stopped` with the note; `runner.test.ts` stop of a run not in `going`; `runView.test.ts` label; `db.rs` upgrade fixture gets the new columns. Both screenshots: a Code chat with a running card showing "Running for".

## Step 12. Two areas, part 1: the switch

**Storage.** Migration 0053 (above). `src/storage/threads.ts`: `ThreadKind`, `Thread.kind`, `kind` in `SELECT_THREAD` (`:91`) and the row mapper; `createThread(..., kind = "chat")` (`:104`) inserts it and defaults the title to "New chat" or "New session". Callers: `ChatApp.tsx:1991` passes the area's kind, `src/runner/runner.ts:140` passes the schedule's kind, `:276` passes `code` (handovers are Code runs). `src/import/write.ts:85` keeps inserting without `kind`; the default is right for imported chats. Export and restore are column-generic; a restore of a pre-0053 export runs the migration's backfill `UPDATE` once as a post-restore step so restored threads with runs land in Code. `db.rs`: new test `threads_take_the_kind_of_their_last_run` modelled on the 0040 test at `:1130` (threads with no run, one code run, a code then a work run → chat, code, work); the seeded upgrade test asserts the seed thread is `chat`. `docs/data-model.md:33` updated.

**View model.** `src/ui/types.ts`: `type Area = "chat" | "code"`, `ThreadView.kind`. `src/app/viewModels.ts`: `areaOf(kind)` (chat → chat, code and work → code), `inArea(thread, area)`, `emptyState(area)` returning the kicker, heading and blurb ("What are you working on?" for Chat; "Describe a task" for Code, so step 16 does not rename it again).

**Switch.** `src/ui/AreaTabs.tsx`, one component with two renderings: `segmented` in the sidebar header (`role="group" aria-label="Area"`, buttons Chat and Code with `aria-pressed`), hidden under 600 px; `bar` (`nav aria-label="Areas"`) fixed to the bottom of the main column, shown only under 600 px, CSS-only like the sidebar's existing `max-[800px]` classes. `Sidebar.tsx` takes `area` and `onArea`; "New chat" and "New chat in <project>" read "New session" in Code; "No chats yet" becomes "No sessions yet"; projects show in both areas (shared); the Runs footer button renders only in Code; Usage and Settings in both; the nav and aside labels stay "Conversations" and "Chat sidebar" to avoid test churn.

**ChatApp.** `area` state read from `fuse.area`; per-area resume keys `fuse.lastThread.chat` and `fuse.lastThread.code` with a one-time fallback to the legacy `fuse.lastThread` (`ChatApp.tsx:541, :598, :1398-1424`); on startup, if the fallback thread's area differs from the saved area, the thread wins (CH-10). `switchArea(next)` sets the area and view, reopens that area's last thread if it still exists, else `newChat()`. `select(id)` (`:1432`) switches area first when the thread belongs to the other one (palette recents, search hits and Runs rows cross areas). `threadViews` (`:3431`) is filtered with `inArea` before `projectViews`; the delete dialog keeps using the unfiltered list. `threadForSend` (`:1991`) sets kind from the area (`work` when the Work toggle is on in Code). `runKind` (`:2603`) defaults from the open thread's kind, or `code` for a Code-area draft; an explicit toggle still wins in this step. Keyboard (`:4070`): Ctrl+1 Chat, Ctrl+2 Code with `preventDefault` (Chromium, Firefox and Edge honour it for these two, unlike Ctrl+N); palette entries "Switch to Chat" and "Switch to Code" as the path that always works. `VITE_FUSE_AREA` read beside `VITE_FUSE_VIEW` (`:1116`) and exported by `scripts/screenshot.sh` so the Code area can be screenshotted. The header title falls back to "New session" in Code. `Messages` gets `empty={emptyState(area)}` (`Conversation.tsx:487-507`).

**Tests.** Update `App.test.tsx:2128` (Ctrl+2 shows "Describe a task", Ctrl+1 back), `:2089` if it seeds the legacy key, `App.webRuns.test.tsx:172` (Ctrl+2 before the Runs badge), `viewModels.test.ts` (kind carried). New: `viewModels.test.ts` for `areaOf`, `inArea`, `emptyState`; `storage.test.ts` for `createThread` kinds; `App.test.tsx`: Ctrl+2 lists only sessions with its own empty state and a session made there is not in Chat; each area reopens its own last item and `fuse.area` is remembered across a remount; opening a session from the palette switches the area; the bottom bar switches areas (query within `navigation "Areas"`, since jsdom renders both); `App.webRuns.test.tsx`: Runs button absent in Chat, present in Code. The Coding-run, HULK and composer tests are untouched: the composer does not change in this step. Windows click-through: untouched (a fresh app starts in Chat). Screenshots: Chat and Code on desktop and web.

**Known one-PR inconsistency.** A Chat-area draft with the Coding-run toggle on still makes a `chat` thread that holds runs, as mixed threads do today. Step 16 removes the toggle from Chat and ends it.

## Step 13. Status and place in the sidebar

**Data.** `ThreadView` (`src/ui/types.ts:234`) gains `kind`, `state?: "going" | "waiting" | "unseen"`, `place?: "local" | "hulk"`. A new bulk query `runStateByThread(db, tenant)` in `src/storage/runs.ts` returns, per thread, the latest run's status and `updated_at` (one query over `runs` using the `runs_by_thread` index) so the sidebar never loops threads. State: `waiting` when the thread has an open approval (desktop: the in-memory `approvals` Map; web: the polled `openApprovals`), else `going` when its latest run is `running`, else `unseen` when that run ended after `threads.seen_at` (0053), else none. `seen_at` is set in `select(id)` (`ChatApp.tsx:1432`) and when a thread is open while its run ends. Place: `hulk` on the web always; on the desktop when `fuse.handovers` holds the thread (`src/handover/watch.ts:15-33`), whose HULK state the existing 5-second `HulkRuns` poll already fetches (`ChatApp.tsx:2789-2815`) and now also feeds the row state.

**Sidebar.** `ThreadRow` (`src/ui/Sidebar.tsx:~374`) renders a state dot before the title (blue pulsing for going, amber for waiting, a filled dot plus bold title for unseen), and in the Code area a place icon and a kind glyph after it, each with an `aria-label`. The hover buttons gain a "More" kebab holding "Mark as unread" (sets `seen_at` to null) so the row stays a button row rather than a new menu system. Project rows roll up their threads' worst state into one dot. The Runs badge logic (`runsBadge`, `ChatApp.tsx:2774`) reuses the same per-thread states.

**Tests.** `viewModels.test.ts` for the state and place mapping; `runList.test.ts` for the bulk query; `App.test.tsx` for the dot, bold-until-opened and Mark as unread; `App.hulk.test.tsx` for the place icon after a handover. Screenshots on both.

## Step 14. A home screen that says what is happening

**Component.** `src/ui/Home.tsx` replaces the empty state in `Messages` (`src/ui/Conversation.tsx:487-507`) when no thread is selected. It renders, in order and only when non-empty: Waiting for you (runs with an open approval, with the question's first line and an Open button), Going (elapsed from step 11 and cost so far), Next scheduled (name, when, where), Today (spend against the day budget from `dailySpend` and `budgetStatesFor`, `ChatApp.tsx:3585`). Empty of all four it shows the current one-line greeting. The composer stays below at every width; the Windows click-through needs `textarea[aria-label="Message"]` visible after Ctrl+N at 640 px, so the lists cap at five rows each and scroll.

**Data.** One `loadHome()` in ChatApp fed by what already exists: the per-thread run states from step 13; `recentRuns` (`src/storage/runs.ts:656`, desktop and web); `handoverState().waiting` on the desktop; `listSchedules` plus `nextRun` (`src/storage/schedules.ts:269, :57`) on the web, and on the desktop through `hulkDb` `db_select` when paired (otherwise the section is omitted); `dailySpend`. Refreshed by the existing one-second web poll and the 5-second desktop HULK poll. Chat and Code homes are the same component; the Code home leads with sessions and the Chat home with today's spend.

**Tests.** `src/ui/Home.test.tsx` for each section and the empty case; `App.test.tsx` adjusts the "What are you working on?" assertions at `:2128`; `App.webRuns.test.tsx` for a waiting run on the home. Quick capture lands on the home unchanged (`ChatApp.tsx:3928-3940`).

## Step 15. Scheduled tasks as a page

**Page.** `view: "scheduled"` and `src/ui/Scheduled.tsx`, opened from a Scheduled entry in the Code area's sidebar. Rows across projects from `listSchedules(db, tenant)` (no project id, `src/storage/schedules.ts:269`) joined to the last run's `spent_micro_usd` and status (a new `scheduleRows` query in the same file). Each row: name, project, status chip (Active when enabled with a `next_at`; Paused when disabled; Done for a once task with a `last_at`), cadence text (reuse the formatting in `src/ui/Schedules.tsx`), next and last run, where it runs ("HULK"), last cost and note, Open its chat (`last_thread_id`), Pause or Resume (toggle `enabled`), Edit (the existing form from `ScheduledTasksSection`, lifted into a dialog that takes a project id), Delete. "New task" asks for the project first, then shows the form; a "From a prompt" picker fills the prompt from the prompt library (`src/ui/Prompts.tsx` data, CH-12). The project dialog keeps its section but links to the page.

**Threads link back.** `runner.ts:130-153` sets `threads.schedule_id` (0053) when it creates the task's thread, so "All runs of this task" lists every thread for the schedule, not only the latest.

**Desktop.** When paired with HULK, the page reads the server's schedules read-only through `hulkDb` `db_select` (`src/handover/api.ts`) and says "Edited on HULK's web app" with a link; when not paired it shows the `WEB_REASONS` text. Nothing on the desktop fires schedules (unchanged).

**Tests.** `src/ui/Scheduled.test.tsx` (chips, cadence, actions); `schedules.test` for `scheduleRows` and the thread link; `App.webRuns.test.tsx` opening the page and pausing a task; a desktop test for the read-only state.

## Step 16. Two areas, part 2: the composers

**Session settings on the thread.** The 0053 columns map to `Thread.session = {mode, newBranch, where, capMicroUsd}` with `setThreadSession(db, tenant, id, patch)` in `threads.ts`. Effective values: mode `?? project.runMode ?? "ask"`; branch `?? true` for Code; where `?? (web ? "hulk" : "local")`; cap `?? DEFAULT_RUN_CAP_MICRO_USD` (and the project's cap from step 11 in between). The three React maps `codeOn`, `codeMode`, `codeBranch` (`ChatApp.tsx:1239-1247`) and the draft-to-thread copy (`:2012-2018`) go; a saved thread reads `thread.kind` and `thread.session`; the draft is one `draftSession` object that `threadForSend` writes onto the new thread. `runs` rows keep recording what each run actually used.

**The one read-only guard.** Plain chat never reaches `chatRun`: `stream()` (`ChatApp.tsx:1830-1960`) only starts a run when `runIn` is non-null, and `runIn` now comes from `thread.kind` (draft: the area), never from a toggle; `stream()` asserts `runIn === null || kind !== "chat"`. Chat keeps what it reads today: CLAUDE.md and AGENTS.md through `sendMessage.ts:74` and a project's read-only MCP tools (`:490`). Chat has no file-read tools today; adding them is not part of this step.

**Chat composer.** `src/ui/Conversation.tsx` drops the props and rendering for Coding run, Work run, the run permission select, New branch and Run on HULK (`:1182-1263`, `:1786-1830`), and the folder chips (`:1748-1785`); `extras()` keeps Think and Compare. `ChangedFiles` (`:2329-2392`) and the context meter (`:1903`) are lifted out as exports for reuse.

**New-session screen.** `src/ui/NewSession.tsx`, rendered when the area is Code and no thread is selected, wrapped in `[data-new-session]`. Controls in this order: Project or repository (project select, plus "Add a folder" for a loose session); Where ("This computer" / "HULK", `aria-pressed`, greyed with the reason when not possible); Mode (`select aria-label="What the coding run may do"`, same options as today); Branch (checkbox "New branch", "named after the task"); Kind ("Coding run" / "Work run", same names as today, `aria-pressed`); Model (the existing "Choose model (Ctrl+K)" trigger); Cost cap (dollars input). The existing composer sits below it unchanged (`textarea aria-label="Message"`, Send, Think, More, attach). Send is greyed with "Pick a project or folder first" until one is chosen.

**Session strip and Files panel.** `src/ui/SessionStrip.tsx`: one line under the header of a code or work thread with where, the folder or repository names, the branch (latest run's `runs.branch`, else "current"), a Mode select that writes `setThreadSession`, cap and spent so far, the context meter, and a Files toggle. `src/ui/FilesPanel.tsx` in the right-panel slot (`ChatApp.tsx:5505-5530`): Changed files (`ChangedFiles` over the union of the thread's runs' changes with `DiffView`, Undo, Undo all, Preview through the existing handlers), Outputs (tool steps with output, per run), Artifacts (`threadArtifacts` → `showArtifact`). It opens by default when the session has changes or artifacts. Run cards already list every step (`Conversation.tsx:2058`); only step outputs stay collapsed, which is the behaviour we keep.

**ChatApp wiring.** `stream()` (`:1902-1930`) takes mode, branch and cap from the session (`startOnServer` and `startChatRun` already accept `capMicroUsd`); `where === "hulk"` on the desktop sends through the existing `runOnHulk` body (`:2857`) instead of a button, which still creates the run's chat on HULK with the local card as today; composer wiring (`:5457-5503`) drops the code props; `NewSessionScreen`, `SessionStrip` and `FilesPanel` are rendered from `ChatApp` with the new UI kept in those three files, no new state maps in ChatApp. The scheduled-task runner keeps taking mode and cap from `schedules`.

**PL-02 greyed cases.** Web: "This computer" greyed with a new `WEB_REASONS.runHere` ("The web app runs on HULK: sessions run there, not on this computer"). Desktop: "HULK" greyed when not paired ("Pair with HULK in Settings first", the string `App.hulk.test` expects), when the project has no repository folder, and for the Work kind if `handOver` turns out to be Code-only (verify in `src/handover/handover.ts`; else allow). Both: Branch greyed when Mode is Read-only and when the folder is not a git repository.

**Tests.** Update `ComposerRow.test.tsx` (main controls lose folder, Code and Work names; the "move into More" cases keep Think and Compare); `Conversation.test.tsx:33` folder chips move to `NewSession.test.tsx`; `App.test.tsx:3031-3311` each starts with Ctrl+2, picks the project in the form and the Kind, then types; the "no Coding run before a folder is linked" assertion becomes "Send is greyed with the reason"; `App.hulk.test.tsx:180-273` uses Where = HULK then Send, with the greyed text on the HULK button; `App.webRuns.test.tsx:118` presses Ctrl+2 and asserts "This computer" is greyed with `WEB_REASONS.runHere`. New: `NewSession.test.tsx` (control order by DOM position, every greyed case shows its reason, Kind toggles); `FilesPanel.test.tsx` (changes from two runs listed once each, Undo calls through, undone rows struck); in `App.test.tsx`: a session's mode and cap survive a reload (read `threads.run_mode`); a chat in a project with a repository never starts a run (`SELECT count(*) FROM runs` is 0); Work kind, HULK and cap reach `run_requests.input` on the web.

**Windows click-through.** `e2e/app.e2e.ts`: both tests press Ctrl+2 once at the start (the area persists); the composer-width check keeps `.rounded-2xl`, "Choose model (Ctrl+K)", "Send message (Enter)", "Think harder" and "More options", while "Add a folder", "Coding run" and "Work run" move to a second check against the `[data-new-session]` rectangle at 640, 900 and 1400 px. The button names are kept so the driver's lookups still resolve. Ctrl+N in Code opens a new session, so the textarea is still focused. Approval dialogs are untouched.

## Step 17. Two areas, part 3: handoff and rollups

**Continue in Code.** An action in the chat header menu (`src/ui/primitives.tsx:112-270`) and in the routing-suggestion banner (`ChatApp.tsx:4173`): creates a thread of kind `code` in the same project, writes `handoff_from_id` on it, and seeds its first user message with the thread summary (the PM-06 summary from `src/chat/summary.ts`, or a fresh one on the Cheap tier when none exists) plus the last three turns quoted. The new session opens in the Code area at the new-session screen with the task text prefilled, so Isaac still picks where and mode before anything runs. **Discuss in Chat** does the reverse from a session: a `chat` thread seeded with the run summary and the list of changed files. Both threads show a small "From: <title>" chip under the header that opens the other.

**The banner trigger.** When a chat message is classified as coding (`src/app/routing.ts` input, `route_intent`) and contains an edit verb (a short list: fix, change, add, edit, refactor, rename, delete, implement, update) and the project links a repository, the existing suggestion banner says "This looks like a change to files. Continue in Code?" with the action. Dismiss is per thread for the session.

**Runs page folded in.** `view: "runs"` and `src/ui/Runs.tsx` go; the Code sidebar gets a filter row Going / Waiting / Done built on the step 13 states; the Runs badge becomes the count on the Waiting chip. `App.webRuns.test.tsx:172` moves to the chips.

**Usage by area and surface.** Migration 0054 adds `request_log.surface`; `logRequest` (`src/storage/requestLog.ts:57`) takes it from a module-level value set once at start: `desktop` in `src/App.tsx` on Tauri, `web` on the web build, `runner` in `src/runner/main.ts`, and `scheduled` when the run carries a `scheduleId` (`RunDeps` gets an optional `surface`). `src/cost/report.ts:22` gains the dimensions `area` (join `threads.kind` in `src/storage/usageReport.ts:19`) and `surface`; `usageView` (`ChatApp.tsx:3740-3800`) gets their titles. Older rows show as "unknown".

**Settings.** A "Code" heading in `src/ui/Settings.tsx` grouping the sections that are about runs: agent audit, sandbox, HULK pairing or server, Python, and the new run limits default. No navigation rework (that is review item 7, not queued).

**Tests.** `App.test.tsx` for Continue in Code and the chip; a `handoff.test.ts` for the seed text; `report.test` for the two dimensions; `requestLog` test that the surface is written; web test for the filter chips.

## Decisions taken in this plan (Isaac can overrule before the run starts)

1. Watchdog defaults: 120 minutes wall clock, 15 minutes without progress, both excluding time spent waiting for an approval; $1 cap unchanged, now overridable per project and per session.
2. Area shortcut: Ctrl+1 Chat, Ctrl+2 Code on desktop and web (browsers honour `preventDefault` for these), with palette entries as the fallback.
3. One migration (0053) carries the thread columns for steps 12 to 17; the run limits (0052) and the request surface (0054) are their own.
4. A thread's kind follows the area it was made in, not the composer toggle; nothing jumps areas under you. Threads that already hold runs are backfilled into Code.
5. The Runs footer button shows only in the Code area (step 12) and becomes the Code sidebar's state filters in step 17. Scheduled lives in the Code sidebar; the project dialog keeps its section.
6. The folder chips, Coding run, Work run, mode, branch and Run on HULK leave the Chat composer in step 16; chat keeps reading CLAUDE.md, AGENTS.md and read-only MCP tools as today. File-read tools for chat are not in this run.
7. A Code-area draft's branch defaults to "new, named after the task".
8. Run cards keep listing every step with outputs collapsed; no auto-expand.
9. "Finished unseen" is a per-database `seen_at`, so the desktop and HULK each keep their own read state until sync (PL-04).
10. Continue in Code opens the new-session screen prefilled rather than starting the run, so where and mode are always chosen by Isaac.
11. Usage rows older than step 17 show the surface as "unknown" rather than being backfilled.
12. The sidebar's nav and aside labels stay "Conversations" and "Chat sidebar".

## Verification at the end of the run

- All seven PRs merged with CI green; the Release workflow built after the last merge.
- Desktop: `scripts/screenshot.sh` of the Chat home, the Code home with a running session, the Code sidebar with dots and place icons, the Scheduled page in its paired or unpaired state, a session with the environment strip and Files panel.
- Web: the same five through `scripts/web-screenshot.py` against a local fuse-server.
- `pnpm test`, `cargo test --features server`, the runs-on-HULK benchmark in CI, and the Windows click-through all green after step 16's composer change.
- Test checklist for Isaac: switch areas with the keyboard on both; start a Code session from the home, hand it to HULK, close the laptop, see the row turn to waiting on the web and the dot on the desktop; let a run idle past 15 minutes in a test project with a 1-minute idle limit and see it stop; pause and resume a scheduled task from the page; Continue in Code from a chat that asks for a file change.
