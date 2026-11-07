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
