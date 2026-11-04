# M12 — Settings navigation and search

Approved by Isaac on 2026-11-04, including building and merging all six steps unattended.
M12 follows the integrated M10/M11 closeout and precedes dictation and deep research.
M10/M11's owner-confirmed activation stays recorded in their milestone files; this work does
not deploy HULK, enroll devices or change existing permissions.

## Goal

Replace the long Settings page with searchable categories, focused panels and direct links.
Reuse the working controls, their validation, save behavior and platform restrictions. Keep
ordinary unsaved edits during category/search navigation and preserve the conversation draft,
attachments, selection and scroll position while Settings is open. Clear sensitive fields and
revealed recovery material when their panel is left, and close panel-owned dialogs.

## Categories (in order)

| Category | Existing settings |
| --- | --- |
| General | Appearance, text size, motion, notifications, quick capture |
| Providers & models | API keys, model catalog, model defaults, routing policy, local model |
| Personalization | Custom instructions, memory, prompt library |
| Costs & limits | Budgets, spend caps per key, model prices |
| Code & tools | HULK pairing, sandbox, Python, MCP servers |
| Sync & devices | Encrypted sync, sync devices and recovery; web server devices and sign-out |
| Privacy & security | Provider permissions, app lock, database recovery key |
| Data & storage | Imports, exports, backups, restore, storage and deletion |
| About & diagnostics | Version and updates, request log, coding activity, routing test set |

The Settings sidebar replaces the conversation sidebar; Back to Chat/Code restores the
originating session. At widths of 800px and above the category sidebar is 220px; below that,
a labeled picker sits above the content. Support 640×480 desktop and 390px web. Use the
approved ledger design (IBM Plex, existing tokens, sentence case, restrained dividers).
Default to General on first use, remember the category locally with an in-memory fallback,
and prioritize explicit targets. Project overrides stay in project settings with explanatory
links or guidance beside their global counterparts. Moving controls changes neither their
storage location nor their sync behavior. No new dependencies, database migrations or
backend APIs; no live provider calls are needed.

## Build mode

One isolated `codex/m12-*` branch and PR per step, sequentially from integrated main.
Preserve other checkouts' work. Use `.claude/skills/ship-step/SKILL.md`, tick each step in
its own PR, attach every PR to the Codex chat, and merge only after checks and CI are green.
Isaac explicitly authorized continuing after each merge until M12 is complete. Stop for an
unresolved product decision, unavailable required access or checks that cannot safely pass.

## Steps

- [x] **1. Roadmap and contract.** This file, current milestone and unattended authorization in CLAUDE.md, roadmap ordering, and UI review item 7 queued here. Preserve M10/M11 closeout evidence and activation status.
- [x] **2. Section boundaries and registry.** Typed stable category/section/control IDs, labels, descriptions, aliases and availability. Separate routing policy from routing diagnostics and coding activity from sandbox controls. Introduce `openSettings(target?)`; retain the current working page.
- [x] **3. Category shell.** All existing controls in their categories, responsive navigation, last-category memory, explicit target handling, preserved ordinary form drafts and conversation state, cleared sensitive fields, closed dialogs and restored focus. Update existing tests to navigate categories.
- [x] **4. Search.** Static metadata only; exact label, prefix, label substring, description/alias, then existing fuzzy matching. Result paths, control focus/scroll, temporary neutral highlight, keyboard navigation, clear/Escape and announced empty state. Retain unavailable controls with reasons. Aliases include dark mode, font, spending, backup, HULK and recovery.
- [x] **5. Direct links and entry points.** `#settings/<category>/<target>` (target optional), initial load, reload, browser history and legacy `#sync`. Invalid settings destinations open General with an explanation. Contextual links for provider keys, pairing, instructions, routing, models and prices; registry-backed section commands in the existing palette. No form values or search queries in URLs.
- [x] **6. Verification and release documentation.** Desktop/web click-through coverage, inspected light/dark screenshots at minimum/typical/wide/mobile sizes, documented navigation behavior, final builds, PR and evidence summary with explicit platform limits.

## Acceptance

- Every existing section remains reachable. Ordinary forms retain their existing save behavior.
- Search dark mode → Theme; HULK → distinct pairing/sync results; recovery → distinct database/sync recovery. Never index values, secrets, memory content or conversations.
- Keyboard-only search, unavailable controls, no matches, reduced motion, focus and category selection work on desktop/web.
- Direct links, `#sync`, reload and Back/Forward reach the intended target without exposing form contents.
- Chat/Code round trips preserve draft text, attachments, selected session and scroll position; running work continues.
- Unsaved instruction/routing edits survive category changes; secret inputs and revealed recovery material clear when left; dialogs cannot remain over another panel.
- Provider connections, privacy, budgets/caps, sync, imports/backups, app lock and diagnostics retain behavior and platform reasons.
- Light/dark layouts at 640×480, 1100×750, 1600px and 390px web have no clipped controls.
- Every PR: `pnpm check` (lint, typecheck, tests, secret scan), required CI green. UI PRs: desktop startup and inspected screenshot plus web verification. Final step: `pnpm build` and `pnpm build:web`, existing Windows and throwaway-server browser checks. Docs-only PRs may omit screenshots.

## Evidence

Append completed-step PRs, verification results and screenshots here as they ship. Synthetic
test data only; production activation is outside this milestone.

- Step 1: [PR #279](https://github.com/isaacholt-hash/fuse/pull/279), all required checks passed; documentation only.

- Step 2: [PR #281](https://github.com/isaacholt-hash/fuse/pull/281), 160 test files / 940 tests passed, all CI green; inspected desktop screenshot at `docs/screenshots/m12/registry.png`; local Chromium web suite passed 5 tests on a throwaway server.

- Step 3: [PR #283](https://github.com/isaacholt-hash/fuse/pull/283), all CI green, 162 test files / 954 tests passed. Chromium click-through passed 6 tests; all nine categories fit 390px. Inspected desktop light, web dark and mobile screenshots are in `docs/screenshots/m12/shell-*.png`.

- Step 4: [PR #284](https://github.com/isaacholt-hash/fuse/pull/284), all CI green, 163 files / 961 tests passed. Chromium web suite passed 7 tests; inspected native HULK search and mobile recovery search screenshots are `search-desktop.png` and `search-mobile.png` in the screenshot directory.

## Direct links

`#settings/<category>` opens a category; adding `/<target>` opens and focuses a registered section or control. Examples: `#settings/general/theme`, `#settings/providers-models/anthropic-key`, `#settings/code-tools/hulk`, `#settings/sync-devices/sync-recovery`, and `#settings/privacy-security/database-recovery`. The category IDs follow the map above (`general`, `providers-models`, `personalization`, `costs-limits`, `code-tools`, `sync-devices`, `privacy-security`, `data-storage`, `about-diagnostics`).

Initial loading, reload and browser Back/Forward use the same registry. `#sync` remains an alias for encrypted sync. Unknown categories, targets and mismatched paths show General with a brief explanation. Search text and form values never become URLs. Category selection and search-result activation create history entries; typing a search does not. Back to Chat/Code restores the originating conversation and clears the Settings fragment. Ctrl+, keeps its existing toggle behavior; Ctrl+Shift+P includes registry-backed Settings section commands and aliases. Explicit links take priority over the locally remembered category.

- Step 5: [PR #285](https://github.com/isaacholt-hash/fuse/pull/285), all CI green, 164 files / 969 tests passed. Eight Chromium click-through tests passed. Inspected native palette-to-routing screenshot: `docs/screenshots/m12/links-desktop.png`.

## Release verification

The release step extends Windows desktop click-through coverage for draft preservation, search, direct links and unsaved instructions. Web coverage verifies aliases, keyboard focus, private-draft exclusion, invalid links, Back/Forward, and full document reloads (including legacy sync). Reload tests use an explicit browser reload and verify that the old document is gone.

The responsive matrix checks every category in both themes at 640×480, 1100×750, 1600×900 and 390×844: 72 cases, with no controls outside the viewport. Long panels scroll within the content area while search and category navigation remain available. Checked-in overview screenshots cover all eight theme/size combinations. Separate native 640×480 light/dark captures verify the category picker in WebKitGTK; its native styling is suppressed so dark text contrast follows the app theme. The picker retains native keyboard and label behavior.

Regression coverage preserves Chat and Code drafts/attachments, selected conversation and focus; ordinary instructions/routing drafts; provider connections, permissions, budgets, sync, import/backup/restore, lock and diagnostics. A saved return-scroll snapshot restores the conversation even if hidden message geometry changes while an answer continues. Recovery links focus the registered heading and never activate reveal controls. Sensitive entries and revealed material clear on panel exit, and late async replies cannot reopen Settings dialogs.

Local validation uses `VITEST_MAX_WORKERS=2 pnpm check`, `pnpm build`, `pnpm build:web`, real Chromium click-through against a fresh throwaway server, and native Tauri startup with inspected screenshots. Release requires all five existing CI jobs to pass, including Windows WebView2, Windows sync/file compatibility and the throwaway-server browser checks. No live provider calls, production deployment, device enrollment, storage policy changes or backend migrations are part of M12. Safari, Firefox and an owner-PC installer were not manually exercised.


Final local results: `pnpm check` passed **164 test files / 971 tests**, with 13 opt-in tests skipped; both production builds passed. All **9 Chromium browser tests** passed on a fresh throwaway server, including the **72 layout cases** recorded in [the bounds report](../screenshots/m12/layout-bounds.json). Native startup and the two minimum-window screenshots were inspected after the picker fix. The release PR records the required CI outcome.

| Viewport | Light | Dark |
| --- | --- | --- |
| 640×480 web | [Screenshot](../screenshots/m12/layout-640-light.png) | [Screenshot](../screenshots/m12/layout-640-dark.png) |
| 1100×750 web | [Screenshot](../screenshots/m12/layout-1100-light.png) | [Screenshot](../screenshots/m12/layout-1100-dark.png) |
| 1600×900 web | [Screenshot](../screenshots/m12/layout-1600-light.png) | [Screenshot](../screenshots/m12/layout-1600-dark.png) |
| 390×844 web | [Screenshot](../screenshots/m12/layout-390-light.png) | [Screenshot](../screenshots/m12/layout-390-dark.png) |
| 640×480 native | [Screenshot](../screenshots/m12/native-minimum-light.png) | [Screenshot](../screenshots/m12/native-minimum-dark.png) |
