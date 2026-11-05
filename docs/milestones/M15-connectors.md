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

- [x] **1. Native accounts and built-in MCP.** Add first-party MCP transport through the existing registry, owner-registered public application IDs, device authorization, native token storage and status-only UI responses.
- [x] **2. Microsoft readers.** OneDrive list/search/read, Outlook Mail list/search/read and Outlook Calendar list/read for personal and work/school accounts, with delegated read scopes and explicit per-service consent.
- [x] **3. GitHub readers.** Repository, issue, PR and pinned diff readers through a read-only GitHub App. Expose source revision and verified path/line metadata for review.
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
Step 1 adds native device authorization and an in-process MCP participant, reusing existing
project permissions, secret storage and redacted activity. Schema 67 adds local public
registration metadata only; existing populated history/server settings are preserved.
No account is authorized by the build. Reader methods ship in steps 2/3 and shared controls
in step 4. See [connector setup and privacy](../connectors.md).

Verification/release evidence will be appended after the current-commit checks pass.

Previous step verified: [M14.4 PR #298](https://github.com/isaacholt-hash/fuse/pull/298) merged
as `85cce8eba73907d3d7be8d9fad408ce1e90b5dd1`. All five gates and JSON merge gate passed
on `7646619921637e30fe21c63b466a3bce8fffdd3d` in
[CI 41997991314](https://github.com/isaacholt-hash/fuse/actions/runs/41997991314).
[Release v0.1.219](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.219) was published
2026-11-05T09:14:47Z by the normal
[release workflow 41999426388](https://github.com/isaacholt-hash/fuse/actions/runs/41999426388).
Linux/Windows installers and all seven signed updater entries matched its eleven uploaded
assets. The recorded research CI artifact passed eight Linux/HULK scenarios in 21,774 ms;
Windows passed six portable cases with the two Linux-server cases explicitly skipped.
Preserved encrypted sync passed 16/16 at schema 66 in 23,276 ms. No deployment or owner
research acceptance was performed.

Step 1 local verification: `pnpm check` passed 1,099 tests across 190 passing files; 21
live/manual or opt-in cases in ten files were explicitly skipped. Focused schema/MCP/platform/
delete coverage passed 15/15. Rust formatting and both default/server all-target clippy checks
passed; default Rust passed 177/177 and server Rust 191/191, including encrypted sync. Eight
new native authorization scenarios cover selective scopes, pending/slow/denied/expired flows,
reconfiguration/cancellation, account switching, refresh, restart, malformed/oversized data
and redaction. The normal browser production build/runner build and click-through passed
10/10. Three startup tests initially exceeded their existing wait under concurrent Rust load;
they passed unchanged in the quieter focused run and full check. No assertion was relaxed.
Real Microsoft personal/work sign-in and GitHub authorization are explicitly unperformed.

Reviewed actual native Settings startup and production web Settings in both themes:
[desktop light](../screenshots/m15/accounts-native-light.png),
[desktop dark](../screenshots/m15/accounts-native-dark.png),
[web light](../screenshots/m15/accounts-web-light.png),
[web dark](../screenshots/m15/accounts-web-dark.png).
These verify the shared app still opens; step 1 adds no sign-in controls. The earlier captures
showed startup/rebuild timing and were rejected, retained only in scratch. Shared connector
setup and its interaction screenshots remain in step 4.


Step 2 adds the eight Microsoft readers through the existing MCP/tool call path. Rust checks
project/provider/service consent before credential use and again before delivering content.
Bounded opaque paging, read-only GET operations, provenance, private download redirects,
revision/size/hash checks and transient document interpretation use existing dependencies.
No database migration is needed: cursors/buffers are process-local, returned content follows
normal conversation privacy. Shared setup and owner sign-in remain in step 4.

Previous step: [PR #299](https://github.com/isaacholt-hash/fuse/pull/299) merged as
`0596fc1c05bb98e3f2af87d430589a47758c8799` on 2026-11-05T09:45:43Z. All five gates and the
JSON gate passed on `1b13223ebb219df7fcbb587d8a89a8644fa3ef6f` in
[CI 42003822453](https://github.com/isaacholt-hash/fuse/actions/runs/42003822453).
Reviewed Windows Code/Files/dictation and both-theme research completion screenshots. CI
preserved dictation 31/31, encrypted sync 16/16 at schema 67 in 49,070 ms, and eight research
HULK scenarios in 21,555 ms without skips. Windows research passed six portable scenarios in
14,008 ms, with its two Linux-server scenarios explicitly skipped.
[Release v0.1.220](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.220) was published
2026-11-05T09:55:40Z by
[release workflow 42005048106](https://github.com/isaacholt-hash/fuse/actions/runs/42005048106).
All eleven assets/seven signed updater entries matched the merged build. No HULK deployment,
account sign-in or owner acceptance was performed.

Step 2 focused verification: nineteen native authorization/reader tests and twenty focused
TypeScript file/PDF/MCP/Chat tests passed. These include in-flight revocation, recipient and
project isolation, private cursors, pagination limits, malformed/bounded responses, secret
redaction, changed file revisions, expanded ZIP limits, source provenance and unchanged generic
MCP text. A separately bundled PDF reader extracted a real recorded PDF from an isolated
folder without node_modules, with native addons disabled. Full checks/release evidence follows.


Step 2 final local verification: `pnpm check` passed 1,106 tests across 191 files, with 21
live/manual or opt-in cases in ten files explicitly skipped (217.90 s). Rust formatting and
both default/server all-target clippy checks passed. Default Rust passed 188/188 (186.91 s)
and server Rust 202/202 (215.75 s), including encrypted sync. Production web and standalone
runner builds passed; the preserved HULK benchmark passed 5/5 (12.99 s). Final production web
click-through passed 10/10 (53.92 s). Empty text and scanned-PDF limitations have explicit
regression coverage. Generated `dist-runner` output is excluded from lint/format checks like
other generated builds; application source remains checked. There are no new dependencies.

Reviewed current native Settings startup and production web Settings in both themes:
[desktop light](../screenshots/m15/readers-native-light.png),
[desktop dark](../screenshots/m15/readers-native-dark.png),
[web light](../screenshots/m15/readers-web-light.png),
[web dark](../screenshots/m15/readers-web-dark.png).
These verify the shared app's startup; this step adds reader/call handling. Shared sign-in and
project controls and their interaction screenshots remain in step 4. Live owner accounts and
provider-backed acceptance remain unperformed.


Step 3 implements ten GitHub readers through the existing native MCP participant. Each read
checks selected-installation read permissions and actual repository membership; public
repository reachability cannot bypass selection. PR base/head and comparison merge-base
commits are pinned. Diff hunk lines and file tree/blob identities provide source evidence;
missing patches/API ceilings are explicitly partial. Native Git-tree walking refuses symlinks
and submodules. No writes, clones, comments, execution, migration or dependency are added.
Shared sign-in/project controls and released owner account acceptance remain in step 4.

Current-commit verification and previous-step release evidence will follow after checks.


Previous step: [PR #301](https://github.com/isaacholt-hash/fuse/pull/301) merged as
`915dfa1a63f460fb2d151ad7d3432fcad04ac2c5` on 2026-11-05T10:56:35Z. All five gates and
the JSON gate passed on `1889e5e1d11383ea9721aee7ad380acd7e3a1409` in
[CI 42013764970](https://github.com/isaacholt-hash/fuse/actions/runs/42013764970). Reviewed
Windows dictation Settings and both-theme research completion. Recorded dictation passed
31/31; encrypted sync passed 16/16 at schema 67 in 21,506 ms; research passed eight Linux/HULK
scenarios in 19,928 ms and six Windows scenarios in 10,649 ms (two Linux-only cases explicitly
skipped). [Release v0.1.221](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.221) was
published 2026-11-05T11:06:07Z by
[release workflow 42014855467](https://github.com/isaacholt-hash/fuse/actions/runs/42014855467).
All eleven assets and seven signed updater entries matched the merged build. No deployment,
account authorization or live provider acceptance was performed.

Step 3 adds native connector fixture execution to the existing Windows compatibility gate;
all five gate names and the existing HULK/encrypted-sync/research/dictation benchmarks are
preserved. Real account authorization remains a separate owner action.


Step 3 final local verification: `pnpm check` passed 1,106 tests across 191 files, with 21
live/manual or opt-in cases in ten files explicitly skipped (245.41 s). Rust formatting and
both default/server all-target clippy checks passed. Default Rust passed 201/201 (208.49 s)
and server Rust 215/215 (245.52 s), including all thirteen new GitHub scenarios and the
existing native authorization/Microsoft readers. A test-only lock held across an await was
fixed before restarting the full verification; no assertion was weakened. Production web
and runner builds passed. The preserved HULK benchmark passed 5/5 (12.43 s), and production
web click-through passed 10/10 (54.03 s). New native Windows fixture execution awaits CI.

Reviewed current native Settings startup and production web Settings in both themes:
[desktop light](../screenshots/m15/github-native-light.png),
[desktop dark](../screenshots/m15/github-native-dark.png),
[web light](../screenshots/m15/github-web-light.png),
[web dark](../screenshots/m15/github-web-dark.png).
These verify current shared startup; this step supplies the GitHub readers. Shared account
controls and their interaction screenshots follow in step 4. Real account authorization and
provider-backed acceptance remain unperformed.
