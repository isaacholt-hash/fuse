# M19 — P2 acceptance and release

## Delivery rules

Approved by Isaac on 2026-11-05 as part of [Finish FUSE P2](../P2-completion.md).
One `codex/m19-*` branch and PR per numbered step, sequentially from integrated main.
Follow `.claude/skills/ship-step/SKILL.md`: tick the box in its PR, run `pnpm check`, relevant
Rust checks, native startup and reviewed screenshots, web verification and all five CI gates
on the current commit. Attach every PR. Continue unattended after each verified merge.
Stop only for an unresolved product decision, unavailable required access or a failure that
cannot safely be resolved. Preserve other worktrees and the existing HULK/sync benchmarks.

Use fixtures and test secrets. Never read or request provider keys. No automatic production
deployment, device enrollment, account authorization or changes to existing permissions.
New tables/columns need forward-only migrations and explicit sync, deletion, backup and
export classification. Active execution and credentials remain local to their owner.

## Requirement coverage

All P2 Must/Should under approved boundaries.

## Steps

- [x] **1. Integrated acceptance.** Run deterministic integrated P2 scenarios, browser/Windows verification, upgrade/migration/backup/restore checks, performance/accessibility checks and resolve scoped failures. Preserve HULK and sync benchmark gates.
- [ ] **2. Release and owner acceptance.** Record actual merged PRs, release/build identifiers, reviewed screenshots, benchmark results and exact desktop/HULK update/setup instructions. Record owner dictation, research, connector and usage acceptance against released builds before closing P2.

## Behavior and boundaries

The build may finish with owner acceptance pending; this is not P2 closure. Keep separate
columns for automated results, skipped/manual checks and owner-confirmed live acceptance.
Existing M10/M11 owner acceptance stays intact, separate from benchmark evidence. Do not
re-run destructive tests on production or replace historic evidence with guesses.

Publish through the normal signed release workflow. Verify the resulting release/assets and
record exact source/build/schema versions for desktop and HULK. Supply update order and
compatibility instructions; do not automatically deploy HULK, enroll/re-enroll devices,
connect accounts or change grants. Owner live checks use an explicitly chosen cap and the
app's existing credentials. Never ask for/read keys or treat skipped updater/microphone tests
as passed. Record rollout issues as scoped follow-up PRs before closure.

## Acceptance

Every P2 Must/Should maps to passed evidence under the boundaries in P2-completion.md.
Existing benchmarks plus new synthetic suites pass with no real provider key. Review native
Windows/Linux and web screenshots in both themes, minimum 640x480 native / 390px web,
typical and wide layouts. Exercise Chrome/Edge and Firefox/Safari-WebKit paths; distinguish
engine CI from owner-device evidence. Check keyboard/focus, reduced motion, no clipped
controls, retained drafts and active background work. Upgrade with populated isolated
databases preserves records; sync/deletion/export/backup classifications and permissions
hold. Owner confirms released dictation, capped research, Microsoft/GitHub reads and usage
reconciliation. Only then mark P2 complete.

## Evidence

Append PRs, exact checks/builds, screenshots and benchmark results as each step ships.
Step 1 (integrated acceptance):

- **Browser engines.** `scripts/browsers-web.sh` runs the shared web app against the native
  server in Chromium, Firefox and WebKit (Playwright 1.64.1, dev-only, approved by Isaac on
  2026-11-06 with axe). Each engine signs in, gets a scripted Markdown document in the
  writing canvas, opens Provider usage reports, and checks a 390px phone layout for sideways
  scrolling. WebKit won't keep a `Secure` cookie on plain `http://127.0.0.1`, so the
  throwaway server uses `--test-plain-http-cookie` (accepted only with `FUSE_SERVER_TEST=1`;
  real servers keep `Secure` behind HTTPS). Local run on HULK: Chromium and Firefox passed. WebKit's system libraries need
  `sudo` on HULK, so WebKit runs in CI only. Results and screenshots:
  [chromium](../screenshots/m19/chromium-result.json),
  [firefox](../screenshots/m19/firefox-result.json), `docs/screenshots/m19/`.
  Native engines remain covered by their own gates: WebKitGTK (Linux desktop screenshot)
  and WebView2/Edge (Windows click-through and the PC tests).
- **Accessibility.** axe (`@axe-core/playwright` 4.14.0, WCAG 2 A/AA) scans chat (light and
  dark), the canvas and settings; any critical violation fails. The first scan found two
  serious issues, both fixed here: shortcut hints at 60% opacity (now the muted text
  colour) and a labelled Research tasks list without a role (now a region). Current scans
  report zero violations in both local engines.
- **Performance.** Recorded per engine (fixture server, scripted replies): sign-in to a
  ready composer about 1–4 s, and send to canvas ready about 0.3–2.2 s.
- **Upgrade, backup and restore.** `src/data/p2Acceptance.test.ts` fills every P2 table,
  exports, wipes and restores: portable comments and versions come back; proposals,
  artifact runs, the offline queue and usage reports never do; delete-all leaves none. The
  Rust upgrade tests (seeded databases through every migration) and the HULK and sync
  benchmark gates are unchanged.
- **Scoped failure fixed.** The parallel-Code web e2e raced the run card after navigation
  (one CI failure on PR #322, green on rerun). It now waits for the card first.

Step 2 (release record; owner acceptance pending):

- **Release.** [v0.1.240](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.240) from merge `a716d9e1a69d091e12fc1cbf638d017b51dda649` ([run 42319070000](https://github.com/isaacholt-hash/fuse/actions/runs/42319070000)),
  published 2026-11-07 00:45:10 UTC with 11 assets: Windows NSIS `.exe` and MSI `.msi`, Linux AppImage, `.deb` and
  `.rpm`, each with its updater `.sig`, plus `latest.json` (seven updater platforms, verified from the live feed). Database schema 78, sync protocol 1,
  prices `2026-10-27`. Desktop and HULK must run this same build (see the update order in
  [p2-acceptance.md](../p2-acceptance.md)).
- **HULK.** Not deployed by the build. At the time of writing HULK serves `86ac0de`
  (2026-11-04, PR #275), 105+ commits and several schema versions behind; sync pauses
  until it's updated, keeping pending edits.
- **Merged P2 PRs.** #286–#288, #290, #291, #294–#296, #298, #299, #301–#303, #305, #307,
  #308, #310, #312, #314, #316–#326. Fixes found after the numbered steps:
  [#323](https://github.com/isaacholt-hash/fuse/pull/323) and
  [#325](https://github.com/isaacholt-hash/fuse/pull/325) (Claude refused strict tool
  schemas: `minimum`, then a nullable enum; owner confirmed chats work on v0.1.239), and
  [#326](https://github.com/isaacholt-hash/fuse/pull/326) (PL-01 phone width: the sidebar
  and canvas squeezed the chat; found while reviewing the M19.1 screenshots).
- **Accessibility, corrected.** M19.1 reported zero violations from local runs; its CI run
  recorded 1–6 serious dark-mode contrast findings per engine. They were frames scanned
  mid-transition; since #326 the scan waits for the theme to settle and all three engines
  (Chromium, Firefox, WebKit in CI on `3172a94`) report zero violations on chat, dark chat,
  canvas and settings.
- **Browser timings (CI, `3172a94`).** Sign-in to composer: Chromium 1.6 s, Firefox 1.5 s,
  WebKit 1.6 s. Send to canvas ready: 0.9 s, 1.0 s, 1.0 s. Overflow at 390px: 0.
- **Benchmarks (CI on `09f0a0f`, same code as v0.1.239; no live provider calls).** Encrypted
  sync (schema 78): initial union 13.3 s, full scenario 41.0 s. Research: 6 scenarios on
  Linux and Windows (2 skipped there: they need the Linux fixture server), 8 on HULK, with
  every scenario's assertions passing (cap and model-call limits block as designed).
  Dictation: 31/31. Parallel
  Code: 15 native and 49 shared, all passed. The HULK benchmark gate passed again on
  `3172a94`.
- **Screenshots.** `docs/screenshots/m19/`: each engine's chat (dark), canvas, reports,
  390px chat, 390px sidebar and 390px canvas. WebKit's are from CI.
- **CI flakes seen on #326.** Attempt 1: the named-skills web step (a draft came back
  empty); attempt 2: the parallel-Code web step (a scripted reply stayed streaming). Both
  passed locally and on attempt 3. The named-skills one recurred on #327 and was a real
  race, fixed in the follow-up composer PR: the composer applied restored or inserted text
  from an effect, one render after the alert, so a fast read saw an empty box. A mutation
  observer showed `""` then the draft before the fix, and the draft at the alert after it.
  The parallel-Code streaming flake is still open.
- **Owner report, 2026-11-07: a long research prompt in Chat stopped with no answer.** Chat
  allowed 3 tool rounds; page reads used them all, and the round without tools wasn't told
  to answer, so the model could end with nothing written. FUSE then showed it as finished
  with no notice. Fixed in `fix/chat-answer-after-tools`: 6 rounds, the last tool results
  carry a note to answer now, and an empty answer gets a notice (`empty_answer`).
- **Impeccable audit, 2026-11-08: 15/20, source only** (Tauri on Linux has no CDP, and the
  browser build needs fuse-server). Fixes, one PR each:
  - `fix/web-auth-non-json`: a page instead of fuse-server's JSON (a proxy, a dev server's
    fallback) crashed the web sign-in gate on `null.signedIn`; it now shows the error screen
    ([#331](https://github.com/isaacholt-hash/fuse/pull/331)).
  - `fix/contrast-and-focus`: focus ring was copper at 50% (≈2.3:1), now full copper; code
    line numbers and the composer placeholder were faded below 4.5:1, now muted (6.1)
    ([#332](https://github.com/isaacholt-hash/fuse/pull/332)).
  - `fix/status-tokens`: 47 raw amber/emerald classes became `--warning`, `--success`,
    `--highlight` and their soft fills, all above 4.5:1, added to the spec's colour table
    ([#333](https://github.com/isaacholt-hash/fuse/pull/333)).
  - `fix/type-scale`: about 390 lines set sans text at 9–11 px, under the spec's 12 px
    margin role; now 12 px, and mono key hints are the spec's 11 px.
  - Not changed: the web app's text size stays greyed on purpose (browser zoom); the global
    reduced-motion kill matches the spec; 24 px buttons meet WCAG 2.5.8.
  - Re-audit after the fixes, source only: **18/20** (accessibility 4, performance 3,
    theming 4, responsive 3, integrity 4). Detector source scan: no findings. Populated
    threads and run cards at 12 px were not screenshotted (no seeded data); empty states
    in Chat, Code, Settings, Usage and dark were.
- **Impeccable critique, 2026-11-09: 25/40** on a populated Chat thread and a Code parallel run
  (throwaway fixture server, scripted replies). Chat's ledger margin reads as FUSE's own; the
  Code run card doesn't. axe: 0 violations. Three P1 fixes, one PR each:
  - `fix/routing-reason`: the margin now says why in plain text ("read as chat, low") and
    "Best ≈ $x" on its own line; a click or Enter opens the rule in full, so the reason no
    longer needs a hover (product rule 1, the spec's margin)
    ([#335](https://github.com/isaacholt-hash/fuse/pull/335)).
  - `fix/run-card`: a finished parallel run leads with "2 done, edits kept apart" and one
    primary Review integration; child tasks are rows, not boxes in a box; branch, plan and
    steps fold under "N steps", and a finished run's own steps under "This run · N steps"
    (open while it works or waits). The e2e driver now matches the first visible element
    ([#336](https://github.com/isaacholt-hash/fuse/pull/336); one CI rerun for the known
    `App.web` sign-in timeout).
  - `fix/money-in-code`: the run card and each child show spend as copper money (sans 13,
    tabular), not muted 11 px mono; the cap is stated once, in the session strip and "cap
    left". "Children spent $x" replaces "Combined … · $0.00 reserved · $5.00 cap"
    ([#337](https://github.com/isaacholt-hash/fuse/pull/337)).
- **Impeccable critique re-run, 2026-11-09: 24/36** (error recovery not scored: the fixture
  shows no error state; about 27/40) on main `ac6fa89`, deployed to HULK the same day. The
  three fixes above held. Two new P1s, one PR each:
  - `fix/run-total`: "Children spent" showed the whole run's total, which includes the
    parent's planning, so the child rows never added up to it; it now sums the rows and
    names the run's total beside it
    ([#338](https://github.com/isaacholt-hash/fuse/pull/338)).
  - `fix/sidebar-row-actions`: a row's five hover icons covered the title and caught clicks
    meant for it; they are one "Actions for …" menu over the cost, the row makes room for it
    so the cost stays readable, and Delete sits apart at the bottom
    ([#339](https://github.com/isaacholt-hash/fuse/pull/339)).
  - `fix/ledger-column` (P2): the ledger column now runs unbroken, as the spec says. Past the
    header the thread total stays at the top as one line ("this thread $0.015"), and the
    composer's estimate sits in the margin as "next message ≈ $0.0102" above "cap left",
    muted and amber only over the cap, which also takes it out of the composer's button row
    ([#340](https://github.com/isaacholt-hash/fuse/pull/340)).
  - `fix/phone-composer` (P2): on a phone the Code session strip fits two rows (16 px
    gutter, a tighter gap, the word "Mode" left to the select's own name), and the
    composer's folder chip keeps its name ("repo", not "r…") instead of shrinking first
    ([#341](https://github.com/isaacholt-hash/fuse/pull/341)).
  - `fix/p3-labels-headings` (P3): each child's Review button is announced as "Review
    changes, child N", so its name starts with the words on it; the Parallel tasks heading
    is an h2 under the thread's h1; and the per-message average reads "≈ $0.003 a message"
    on one line in the margin
    ([#342](https://github.com/isaacholt-hash/fuse/pull/342)).
  - `fix/plain-vocabulary` (P3): the run card names a child's planner by display name
    ("Claude Opus 5.5", not "anthropic/claude-opus-5-5"), shortens the child branch to its
    first ID block (full name on hover), and lists a "1. … 2. …" plan as numbered items; the
    composer reads "context 0% used" in body type, and the margin says "read as chat,
    simple" instead of "chat, low".
  - `fix/plain-run-steps` (P1/P2, critique re-run 2026-11-10): the run's own plan names its
    model ("Plan · Claude Opus 5.5") and lists its steps; IDs in step text shorten to their
    first block; a model turn's count reads "20 tokens"; the parallel-start approval asks one
    question ("Start 2 parallel tasks from commit d2180e5?"), lists the tasks, and keeps the
    guarantees in plain weight; a task's own approvals name its worktree short ("In this
    task's own worktree, fuse/child/9217cc3e"), full name on hover; "Tasks spent".

| Check | Automated | Owner on a released build |
| --- | --- | --- |
| Claude chat (fixes #323/#325) | Fixture tests | Passed, v0.1.239, Windows, 2026-11-06 |
| 1 Dictation | 31-test benchmark, web fixture | Pending |
| 2 Deep research, capped | Recorded benchmark, 3 platforms | Pending |
| 3 Microsoft and GitHub reads | Connector web fixture | Pending |
| 4 Writing canvas | 3 engines + canvas web step | Pending |
| 5 Python artifacts | Artifact-run web step | Pending |
| 6 Offline queue | Unit and fixture tests | Pending |
| 7 Usage reports | Reports web step | Pending |
| HULK on this build | Not automatic | Pending (owner deploys) |

P2 stays open until the owner rows read Passed (or Skipped, stated as such).
