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

- [x] **1. Routing and search interfaces.** Complete Best planning/final synthesis, Balanced-or-floor routine work and Cheap housekeeping across runs, respecting explicit pins. Add bounded provider-native search options, conservative request bounds and a research run kind; keep research in Chat.
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
Step 1 completes Auto's Best plan → routed Balanced-or-floor tool work → Best final
synthesis. Explicit pins keep their chosen model and no separate Auto planner is added.
The final request has no tools and consumes recorded evidence as untrusted data. A missing
plan, blocked provider, unknown bill or insufficient cap pauses rather than silently skipping
a stage. Completion and stage transitions commit atomically with their model step. Continue
resumes final synthesis without repeating worker/file turns; a completed run is not rerun.
Cheap/local housekeeping retains its existing limits and never answers the user.

Schema 64 extends the existing run kind with `research` and adds owner-local `routing_stage`.
Existing rows/IDs, foreign keys and sync events survive without recapture. The new column is
explicitly local in `data/sync.json`, excluded from portable trigger payloads. It is deleted
with its run and included only in that installation's encrypted database backups. Existing
JSON exports exclude runs and therefore this checkpoint; restoring/importing history never
executes it. Research cannot enter the Code engine or acquire its folders/tools; its
restricted executor and Chat entry arrive in steps 2 and 3. No research start UI ships here.

Both provider adapters accept finite native search bounds and emit typed sources, search
actions and separate billed-counter status. OpenAI uses `max_tool_calls`; Anthropic uses
`max_uses` on basic direct search, without dynamic code execution. Search reservations cover
all possible bounded inference iterations and tool charges. Missing billable counters retain
exposure as unresolved instead of presenting inferred calls as actual spend. Dated policy is
in `data/research.json`; fees and authoritative references are in the existing catalog and
[provider documentation](../providers.md).

Step-1 local checks: default/server Rust clippy passed with warnings denied; all 169
default and 183 server tests passed, including the unchanged encrypted-sync benchmark.
The HULK benchmark passed all five recorded scenarios against a throwaway schema-64 server
with in-memory test secrets. No provider call, deployment or account authorization occurred.
[Native startup in light](../screenshots/m14/routing-native-light.png) and
[dark](../screenshots/m14/routing-native-dark.png) was reviewed on a fresh database/keyring.
The 9.9.9 updater banner is scripted fixture data.

The focused tests cover stage ordering, same-model Auto stages, explicit pins, missing Best,
cap pause/resume without repeated work, completed-run idempotence, current-provider policy,
malicious final tool calls, final-model attribution and complete cost totals. Both provider
fixtures cover bounded search sources/counters; missing counters retain unresolved billing.
A populated migration test checks all run values, linked steps, trigger definitions, pending
sync events, new research history publication and checkpoint exclusion.

Full TypeScript checks, production browser verification and current-head CI results are
recorded with the step PR before merge.

Production `pnpm build:web` and Chromium click-through passed 10/10; reviewed browser
[light](../screenshots/m14/routing-web-light.png) and
[dark](../screenshots/m14/routing-web-dark.png) screenshots are retained. The preserved
synthetic dictation browser scenario passed 1/1. The separately recorded encrypted-sync
benchmark passed 16/16 on schema 64, two independent replicas and one throwaway HULK in
32,741 ms: [JSON evidence](../screenshots/m14/routing-sync-benchmark.json).
The final focused routing/accounting suite passed 34/34; its app click-through regressions
passed 3/3 after adding the final synthesis turn to their fixtures. Final answers retain
their producing model's attribution and the run's combined actual spend. Missing final
usage remains unresolved and is never displayed as a known step charge.

Final `VITEST_MAX_WORKERS=2 pnpm check` passed: 177 test files / 1,039 tests passed,
with 13 live/manual tests skipped (eight files). Lint, typecheck, formatting and secret scan
passed on the completed step. Current-head Windows/CI and release evidence belongs to the
step PR and the next delivery record; no skipped owner acceptance is presented as passed.
