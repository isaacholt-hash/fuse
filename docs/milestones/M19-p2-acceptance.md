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

- [ ] **1. Integrated acceptance.** Run deterministic integrated P2 scenarios, browser/Windows verification, upgrade/migration/backup/restore checks, performance/accessibility checks and resolve scoped failures. Preserve HULK and sync benchmark gates.
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
No acceptance evidence has been recorded for this milestone yet.
