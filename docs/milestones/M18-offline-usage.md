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

- [x] **1. Durable queue.** Explicit normal-Chat offline queue on its originating desktop, with edit/cancel/pending controls and persisted immutable dispatch identity. Incognito remains transient.
- [x] **2. Reconnect and recovery.** Deliver serially per thread with notice, recheck context/policy/prices/budgets, require renewed approval for material changes and stop ambiguously dispatched requests without paid replay.
- [x] **3. Usage collection.** Usage CSV export/import plus native OpenAI usage/cost and current Anthropic Usage and Cost Analytics collectors, explicit separate native reporting credentials and sanitized status-only UI.
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

## Evidence

Step 1 adds the explicit offline queue ([offline.md](../offline.md)) and schema 76
(`offline_queue`, owner-local, installation-bound, immutable dispatch identity, eligibility
and close triggers). The composer queues instead of sending only when offline on the
desktop, for a saved non-incognito Chat with nothing attached. Edit and Cancel apply only
while a message waits. Checks: `pnpm check`, Rust fmt/clippy/tests (migration upgrade
tests), storage tests (eligibility, edit/cancel, block on delete/incognito, purge) and App
tests (queue, edit, cancel, no provider call, survives restart; incognito refused; online
sends as usual). The offline composer couldn't be screenshotted natively here (no network
namespace permission), so its UI evidence is the App tests. Nothing is delivered yet: M18.2.

Step 2 delivers the queue on reconnect ([offline.md](../offline.md)). Schema 77 adds the
queued route snapshot. Delivery runs through `send` with a delivery handle: every point
that would ask interactively (budget over, large request) or refuse (routing, keys, spend
caps, privacy) holds the message for Send now instead, and a different model or price than
the snapshot does too. The row is claimed `queued`→`dispatching` only after every check,
right before the provider path; a crash leaves it `unknown` at the next start and nothing
replays. Rows from another installation or a restore never send by themselves. Checks:
`pnpm check`, Rust fmt/clippy/tests, storage tests (single claim, hold, crash) and App tests
(ordered delivery, price-change hold and Send now, crash and foreign rows not sent).

Step 3 adds provider usage collection ([usage-reports.md](../usage-reports.md)), schema 78.
`src-tauri/src/usage_reports.rs` reads only fixed report URLs with dedicated
`report:<provider>` credentials, follows pagination, replaces the seven-day window on success,
keeps the last good report on failure, and stores fixed messages only. A six-hourly loop
runs where the owner chose (this computer or HULK). Settings shows status only, plus usage
CSV export and import. Checks: `pnpm check`, Rust fmt/clippy/tests (date and amount
conversion, both providers' parsing, a local fixture server for pages, corrections, 401/429,
headers and no chat-key use), storage and App tests, and `scripts/reports-web.sh` against
the native server (schema 78, no key, a refused refresh with no request), with light and
dark screenshots in `docs/screenshots/m18/`.
