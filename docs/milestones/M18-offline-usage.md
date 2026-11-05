# M18 — Offline sends and usage reconciliation

## Delivery rules

Approved by Isaac on 2026-11-05 as part of [Finish FUSE P2](../P2-completion.md).
One `codex/m18-*` branch and PR per numbered step, sequentially from integrated main.
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

PL-05, CO-06, MM-12 dependency, SE-10 completion, CO-08.

## Steps

- [ ] **1. Durable queue.** Explicit normal-Chat offline queue on its originating desktop, with edit/cancel/pending controls and persisted immutable dispatch identity. Incognito remains transient.
- [ ] **2. Reconnect and recovery.** Deliver serially per thread with notice, recheck context/policy/prices/budgets, require renewed approval for material changes and stop ambiguously dispatched requests without paid replay.
- [ ] **3. Usage collection.** Usage CSV export/import plus native OpenAI usage/cost and current Anthropic Usage and Cost Analytics collectors, explicit separate native reporting credentials and sanitized status-only UI.
- [ ] **4. Reconciliation and activity.** Compare matching UTC periods/provider scopes, show lag/unexplained differences without counting aggregates as new spend, and complete redacted tool/credential-use/policy export. Fixtures, screenshots and release documentation.

## Behavior and boundaries

Queue only messages the owner explicitly queued. Keep the dispatch queue local and out of
sync and portable restore so another device cannot send it. A deleted thread or tightened
policy cancels/blocks its queued payload. Do not create an automatic Code/research run from
an offline message or restore. On reconnect, notify and apply current preflight checks. A
crash after dispatch may leave unknown billing: do not claim exactly-once provider execution
or automatically repeat it. Ordinary drafts/history and local housekeeping still work offline.

Usage collectors are off until configured by the owner. Use dedicated reporting credentials
in the native secret store; never reuse or promote a chat credential implicitly. They may
need organization/admin permissions; show that clearly. Native requests only allow fixed
read-only reporting endpoints. Never expose credentials, headers or report raw bodies in logs.

Prefer HULK as collector when explicitly configured there; otherwise collect while that
native installation runs. Refresh on setup/explicit Refresh and every six hours; revisit the
last seven UTC days for late corrections. Preserve pagination and snapshot identities. No
provider call in fixtures. [OpenAI reports](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs)
and [Anthropic analytics](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api).

Reconcile only matching periods, currency and provider project/workspace/key identifiers.
Show unavailable dimensions, shared-key external usage and lag instead of inventing per-FUSE
request attribution. Provider report totals never enter the actual request ledger as new
spend. CSV fallback works without admin access. Reporting configuration and credentials stay
local; explicitly classify safe aggregate snapshots and redact sensitive audit inputs.

## Acceptance

Offline edit/cancel, reconnect twice, concurrent dispatch, crashes before/after dispatch,
policy/price changes, deletion and incognito. No restored/replicated queue executes. Repeated
report pages, 429/auth failures, wrong scopes/currency, delayed corrections, CSV corruption,
report lag, imported/API duplicates and rollup agreement. Logs/export/sync contain no secrets.
Owner operates live reporting setup; unavailable account permissions do not block fixtures.

## Evidence

Append PRs, exact checks/builds, screenshots and benchmark results as each step ships.
No acceptance evidence has been recorded for this milestone yet.
