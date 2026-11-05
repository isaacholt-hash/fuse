# M14 — Deep research and run routing

## Delivery rules

Approved by Isaac on 2026-11-05 as part of [Finish FUSE P2](../P2-completion.md).
One `codex/m14-*` branch and PR per numbered step, sequentially from integrated main.
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

FK-12, RT-14, AG-06, AG-05; bounded search and CO-08.

## Steps

- [ ] **1. Routing and search interfaces.** Complete Best planning/final synthesis, Balanced-or-floor routine work and Cheap housekeeping across runs, respecting explicit pins. Add bounded provider-native search options, conservative request bounds and a research run kind; keep research in Chat.
- [ ] **2. Research engine.** Restricted read-only tool profile, execution-owner checkpoints, collected sources and a versioned cited Markdown report. Enforce cap and work limits, validate source links, flag unsupported claims and retain partial results. No commands, repository writes or additional MCP access.
- [ ] **3. Chat controls.** Research action without a linked-folder requirement, scope/estimate/location preview and an unfilled cap field required to start. HULK preferred when permitted, explicit desktop option, progress/pause/stop and explicit continuation. Portable finished reports/history, owner-only active coordination.
- [ ] **4. Benchmark and release.** Deterministic recorded research scenarios, both provider adapters, desktop/web click-through, HULK continuation after caller disconnects, interrupted desktop behavior, reviewed screenshots and setup documentation.

## Behavior and boundaries

Default limits are 12 searches, 24 fetched sources, 30 model calls and 30 minutes. Stop with
an explicitly partial report when a work limit is reached. Only offer provider/model
combinations with a conservative computable request-cost bound; reserve before dispatch.
Every research run requires an owner-entered cap, with no preselected amount.

Use existing context assembly, policy, budget, runner and approvals. Snapshot only explicitly
selected, permitted context; never export local-only content to HULK. Prefer HULK only when
paired, compatible and allowed; desktop execution is an explicit option, unavailable in the
browser with a visible reason. Do not repurpose repository handover to grant research access.

Reports contain linked citations, source provenance, limitations and unresolved disagreements.
Check references against collected sources and expose unsupported assertions. Treat fetched
content as untrusted data. A closed browser does not stop a HULK-owned run. A stopped desktop
process leaves interrupted work; restarting/syncing history never executes it. Resume is
explicit and must not repeat ambiguously billed calls.

## Acceptance

Estimate/cap required, policy and private-context exclusion, unsupported model bounds, hostile
sources, missing/duplicate/conflicting citations, partial reports, all limits, stop/pause,
crashes around checkpoint/settlement, repeated queue delivery, single execution owner,
HULK continuation with caller disconnected and explicit desktop resume. Cost totals retain
all attempts without duplicate accounting or provider calls in CI.

## Evidence

Append PRs, exact checks/builds, screenshots and benchmark results as each step ships.
No acceptance evidence has been recorded for this milestone yet.
