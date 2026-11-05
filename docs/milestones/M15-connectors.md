# M15 — Microsoft and GitHub connectors

## Delivery rules

Approved by Isaac on 2026-11-05 as part of [Finish FUSE P2](../P2-completion.md).
One `codex/m15-*` branch and PR per numbered step, sequentially from integrated main.
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

AG-11 through AG-02; supports CA-10.

## Steps

- [ ] **1. Native accounts and built-in MCP.** Add first-party MCP transport through the existing registry, owner-registered public application IDs, device authorization, native token storage and status-only UI responses.
- [ ] **2. Microsoft readers.** OneDrive list/search/read, Outlook Mail list/search/read and Outlook Calendar list/read for personal and work/school accounts, with delegated read scopes and explicit per-service consent.
- [ ] **3. GitHub readers.** Repository, issue, PR and pinned diff readers through a read-only GitHub App. Expose source revision and verified path/line metadata for review.
- [ ] **4. Setup and verification.** Shared M12 Settings controls, project enablement, account expiry/disconnect/tenant errors, deterministic authorization and pagination fixtures, desktop/web parity, reviewed screenshots and exact registration instructions.

## Behavior and boundaries

Microsoft replaces Google services in AG-11. Use Microsoft Graph through a first-party MCP
implementation, not an unreviewed downloaded server. GitHub uses its API through the same MCP
registry. Results go through current bounds, provider restrictions, provenance, injection
checks and logging. Start with read operations; existing generic MCP behavior is preserved.

Owner registers public-client applications; no embedded client secret or relay. Device
sign-in supports native and headless HULK participants. Microsoft requests only delegated read
access for enabled services, refreshes natively and surfaces tenant/conditional-access limits.
GitHub App permissions are read-only and repository-limited; renew with sign-in on expiry if
refresh would need a client secret. Never weaken permissions or request a secret to avoid it.

[Microsoft accounts](https://learn.microsoft.com/en-us/graph/users-you-can-reach),
[device flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code),
[Graph scopes](https://learn.microsoft.com/en-us/graph/permissions-reference),
[GitHub device authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

Tokens remain only on the authorized installation or HULK and never sync. Require project
enablement; account consent alone enables no tools in a project. Disconnect clears native
credentials and explains provider-side revocation. List/search/read responses and selected
file content must pass egress checks before reaching a model. No background account crawl.

## Acceptance

Personal/work accounts, selective scopes, denied consent, pending/slow/expired device flow,
wrong account, refresh/sign-in, tenant refusal, cancellation, disconnect, pagination and rate
limits. Private results stay out of blocked providers and unenabled projects. Host/URL checks,
malicious returned links and instructions, no credentials in UI responses/logs/export/sync.
Use isolated mock OAuth/API endpoints in tests. Real account authorization is owner-operated.

## Evidence

Append PRs, exact checks/builds, screenshots and benchmark results as each step ships.
No acceptance evidence has been recorded for this milestone yet.
