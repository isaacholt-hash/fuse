# M16 — Coding completion

## Delivery rules

Approved by Isaac on 2026-11-05 as part of [Finish FUSE P2](../P2-completion.md).
One `codex/m16-*` branch and PR per numbered step, sequentially from integrated main.
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

CA-10, CA-12, CA-14; shared AG-04/05 and RT-14.

## Steps

- [x] **1. Structured review.** Review pinned local changes, branches and GitHub PRs using the M15 reader. Findings carry severity, verified path/line and evidence. Reviewing edits no files and posts no comments.
- [x] **2. Named skills.** Import instruction packages and supporting files; invoke by a distinct named command, preserve provenance/version and reuse prompt/context assembly. Packages confer no permissions.
- [x] **3. Skill scripts.** Run explicitly invoked package scripts only through the existing sandbox, permissions and approvals, with safe package paths and bounded outputs. No automatic execution on import.
- [x] **4. Child execution.** Add parent/child runs with isolated worktrees, a single execution owner and atomic reservations against one combined cap. Stop propagates; no recursive delegation.
- [x] **5. Parallel controls and integration.** Show child plans/progress/cost and combined spend. Require approval for exact child commits before integration; changed parents/conflicts pause. Preserve failed-run evidence and finish benchmark/screenshots/documentation.

## Behavior and boundaries

Review is read-only; a fix action may create an editable Code draft but never starts it.
Pin snapshot/revision identifiers so findings cannot silently refer to later edits. Findings
must explain a concrete consequence and identify evidence on the reviewed revision.

Skill definitions/assets are app-managed imports or reads from explicitly granted folders.
Check archive paths, bounds and referenced files. No credentials or machine grants travel
with a package. Script execution receives only the approved sandbox inputs/environment.
Portable imported packages may sync as app-managed content; execution grants remain local.

Parallel Code work requires a git repository and separate worktrees. Default to at most
three children and one level of delegation, with explicit tasks. Children inherit restrictions,
not wider permissions. All planning, child and parent synthesis costs use the combined cap.
Review child diffs before approving exact commits for integration. Never modify unrelated
dirty parent work; retain worktrees/evidence on failure. No automatic commit integration,
push or PR publication. Non-git Work sessions show why parallel worktrees are unavailable.

## Acceptance

Review wrong/stale revisions and invented lines; read-only enforcement. Malicious package
paths/symlinks, oversized assets, script approval/denial and sandbox escape tests. Concurrent
reservations, cap exhaustion, crash/reconnect, child stop, parent stop, changed parent,
conflicts, integration approval replay and failed-worktree retention. Replicas never execute
children or inherit grants from synced history. Recorded fixtures, Windows compatibility,
HULK ownership and both-theme desktop/web controls.

## Evidence

Append PRs, exact checks/builds, screenshots and benchmark results as each step ships.
Step 1 adds Options / command-palette Review code, pinned native Git and project-enabled
GitHub capture, a restricted staged review engine and verified structured findings. It uses
existing run ownership, request accounting, budgets and read-only history. Captured source
and request recovery remain owner-local; schema 68 adds a portable profile marker that
prevents generic execution of a review replica. Setup, limits and recovery are documented in
[code-review.md](../code-review.md). No dependencies, account authorization, repository edits,
GitHub comments, deployment or device enrollment are added.

Focused verification so far: 26 shared engine/evidence/source/migration/control tests passed
(3.58 s), plus five new native Git scenarios (the initial filter also selected two existing
preview tests). The full browser fixture passed 2/2 (35.92 s) using an isolated real repository,
native encrypted database and HULK-style Node runner, with three synthetic accounted requests,
1,100 micro-dollars, no live provider calls, no changes and one pre-existing fixture folder
grant. The repository retained exactly its original dirty file. Screenshot review caught a
conversation-header default mismatch; the review conversation now stores the selected
read-only mode and cap, with a browser assertion. Two additional no-charge/crash recovery
regressions follow in final verification. All ten browser captures are reviewed in both themes. Native startup exposed a dark select
contrast issue, now fixed with theme backgrounds and explicit control color schemes; final
native captures and full evidence follow after verification.

Previous milestone: [PR #303](https://github.com/isaacholt-hash/fuse/pull/303) merged as
`0f9ec0baddd0653e94e42005c503b03f17a64b97` on 2026-11-05T12:54:14Z. Its five gates and JSON
gate passed on `5cb4dbe832db48165552ec731af4eff971395433` in
[CI 42029204959](https://github.com/isaacholt-hash/fuse/actions/runs/42029204959).
Windows native connectors passed 41/41 (271.25 s), sync compatibility 29/29 and atomic files
9/9. Reviewed Windows dictation Settings/research completion and connector web interactions.
Preserved benchmarks: dictation 31/31; encrypted sync 16/16 at schema 67 (38,900 ms); research
eight Linux/HULK scenarios (22,285 ms) and six Windows scenarios (13,319 ms), with two Linux
server cases explicitly skipped. [v0.1.223](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.223)
was published 2026-11-05T13:03:38Z by
[release workflow 42031070956](https://github.com/isaacholt-hash/fuse/actions/runs/42031070956).
All eleven assets and seven updater entries matched the published signature files. M15 live
account/provider acceptance remains separate owner work; no activation was performed.


Full Rust verification now passes: default 215/215 (236.18 s), server 229/229 (255.89 s),
with formatting and both all-target clippy configurations clean. The first full run found
one dispatch error-prefix mismatch (214/215 passed); the endpoint now uses the existing
argument helper. The focused dispatch regression passed, and both complete suites passed
again without weakening assertions. An additional GitHub review integration passed through
the normal run entrypoint with zero linked folders or local repository access (source suite
5/5, 7.95 s under concurrent native checks). Final application/build/browser evidence is recorded below.


Final application verification: `pnpm check` passed 1,146 tests in 198 files, with 21 live/manual
or opt-in cases in ten files explicitly skipped (240.09 s). Lint, formatting, type checking and
secret scan passed. Production web and standalone runner builds passed. No dependencies or
existing assertions were weakened. Preserved HULK and final browser/native evidence is recorded below.


The preserved HULK benchmark passed 5/5 (12.71 s). The final full-app browser fixture passed
2/2 (36.07 s), again with three synthetic requests totaling 1,100 micro-dollars, no live provider
calls, no changes and one pre-existing fixture folder. It verifies the stored read-only mode
and selected five-dollar cap; the repository retains exactly its original dirty file. The
current-source setup/result/mobile screenshots were reviewed in both themes. Fresh native captures were reviewed after the WebKit dark-control contrast correction:
[desktop light](../screenshots/m16/review-native-light.png),
[desktop dark](../screenshots/m16/review-native-dark.png).
Current browser captures:
[setup light](../screenshots/m16/review-web-local-setup-light.png),
[setup dark](../screenshots/m16/review-web-local-setup-dark.png),
[branch](../screenshots/m16/review-web-branch-setup-light.png),
[GitHub access explanation](../screenshots/m16/review-web-github-unavailable-dark.png),
[result light](../screenshots/m16/review-web-review-result-light.png),
[result dark](../screenshots/m16/review-web-review-result-dark.png),
[mobile light](../screenshots/m16/review-web-review-mobile-light.png),
[mobile dark](../screenshots/m16/review-web-review-mobile-dark.png).
All twelve current native/browser images are committed; the browser fixture includes both
themes for every state. Live provider-backed review accuracy and additional browser engines
remain separate M19 acceptance, never inferred from synthetic fixture results.

Step 1 shipped in [PR #305](https://github.com/isaacholt-hash/fuse/pull/305), merged
2026-11-05T14:09:21Z as `0a7bf5e95149482703143a9a915ceff19224c3ec`. All five gates passed on
`3d7a729ad97dd1bc2f28382cbdcb803bb8945fbd` in
[CI 42038945190](https://github.com/isaacholt-hash/fuse/actions/runs/42038945190), followed by
`bash scripts/ci-green.sh 305`, CLEAN merge status and no unresolved review/comments. Windows
native review passed 4/4 (2.39 s), connectors 41/41 (287.30 s), sync compatibility 29/29 and
atomic files 9/9. Windows click-through passed 16 tests; 18 environment/fixture cases were
explicitly skipped, including the existing Windows Server NUL sandbox limitation. Windows
Settings and research completion images were reviewed in both themes.

Preserved CI benchmarks: dictation 31/31; encrypted sync 16/16 at schema 68 (38,417 ms);
research eight Linux/HULK scenarios (22,231 ms) and six Windows scenarios (15,591 ms), with
two Linux server cases explicitly skipped on Windows. The new CI browser fixture retained
three synthetic requests / 1,100 micro-dollars, no live provider calls, no changes and one
existing folder. Its setup, report and mobile images were reviewed.

[v0.1.224](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.224) was published
2026-11-05T14:27:34Z by [release 42042262585](https://github.com/isaacholt-hash/fuse/actions/runs/42042262585),
attempt 2. Attempt 1 encountered a Linux bundler HTTP 504 and cleaned up its draft; the full
normal workflow succeeded on retry. All eleven assets were present and all seven updater
entries matched their published signature files. No HULK deployment or live acceptance occurred.

Step 2 implementation adds the separate Skills library, explicit named/version-pinned
invocation, immutable imported instructions/support files and scoped read-only support tools.
[skills.md](../skills.md) documents the format, bounds, authority, privacy, deletion and backup
behavior. Schema 69 classifies both tables and all columns; no dependencies are added. Early
verification passed 33 new package/storage/invocation/UI cases, plus the surrounding Chat,
context and Code suites (59 focused cases total). Native sync dependency/deletion and privacy
withdrawal tests passed 2/2 (6.18 s). Shared browser import/cancel/palette/draft/deletion-review
verification passed 2/2 (16.23 s), with one package/version and zero requests, runs or folders.
Final source captures and complete checks follow before the step's PR.

Complete local Rust suites passed 217/217 default (241.56 s) and 231/231 server (271.40 s),
with formatting and both all-target clippy configurations clean. The final privacy-flag
comparison now captures the package withdrawal atomically with the flag write. Its strengthened
native staging/deletion/privacy tests passed again in both configurations: 2/2 default (4.83 s)
and 2/2 server (4.67 s), followed by both all-target clippy checks.

The complete application check passed 1,179 tests in 202 files, with 21 existing live/manual
or opt-in cases in ten files explicitly skipped (252.38 s). Lint, formatting, type checking
and the secret scan passed. The first full run caught a palette regression: the added Settings
destination pushed saved prompts past the default 50-item list. Libraries now precede individual
Settings destinations. The existing prompt regression passed unchanged, followed by this complete
passing rerun; the failed run and its evidence were retained. Invalid skill validation also
restores the editable draft before any classifier/provider dispatch.


Final production web and standalone runner builds passed. The preserved HULK benchmark passed
5/5 (12.74 s). Current-source shared browser verification passed 2/2 (33.81 s), including an
unavailable skill restoring the exact editable draft before any classifier/provider dispatch.
Its native database held one package and one version, with zero requests, runs or folders.
Fresh native startup/captures passed in both themes; all fourteen current images were reviewed:
[native light](../screenshots/m16/skills-native-light.png),
[native dark](../screenshots/m16/skills-native-dark.png),
[import preview](../screenshots/m16/skills-web-import-preview-light.png),
[library dark](../screenshots/m16/skills-web-library-dark.png),
[editable invocation](../screenshots/m16/skills-web-editable-invocation-light.png),
[mobile](../screenshots/m16/skills-web-mobile-invocation-dark.png),
[unavailable draft](../screenshots/m16/skills-web-unavailable-draft-dark.png), and
[deletion review](../screenshots/m16/skills-web-delete-review-light.png).
Every browser state has committed light/dark captures. Windows and current-head CI evidence
will be recorded with the PR; no live provider-backed or owner acceptance is inferred.


Step 2 shipped in [PR #307](https://github.com/isaacholt-hash/fuse/pull/307), merged as
`63085c9c552c2c23e1c9501d1f50dbcffc0336e9` at 2026-11-05T15:01:55Z. All five gates and
JSON gate passed on `530170226c32a5150e78f52511ff24c52b2ba943` in
[CI 42048782269](https://github.com/isaacholt-hash/fuse/actions/runs/42048782269).
Windows skills passed 30/30, native sync 31/31, atomic files 9/9, code review 4/4 and
connectors 41/41. Windows click-through: 16 passed, 20 explicitly skipped; shared skills web
passed separately. Preserved benchmarks: dictation 31/31; sync 16/16 at schema 69 (25,583 ms);
research eight Linux/HULK (21,575 ms), six Windows (15,599 ms), two Linux-only cases skipped
on Windows. Local checks passed 1,179 tests with 21 skips; Rust default 217, server 231.
All fourteen `skills-*` desktop/web captures were reviewed. The Windows research capture
labelled light actually retained a dark frame, so it is not evidence for both Windows themes;
M19 retains this visual verification gap.
[v0.1.225](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.225) was published at
2026-11-05T15:12:37Z by
[release 42050815835](https://github.com/isaacholt-hash/fuse/actions/runs/42050815835).
All eleven assets and seven updater entries match their published signature files.

Step 3 adds the `run_skill_script` command through existing Code/Work approvals and Python
result handling, including explicitly approved output destinations and undo. A narrow native command verifies pinned package bytes and scopes, atomically
claims dispatch, then executes only the selected script with bounded literal arguments.
Linux bubblewrap receives no host folders or network and refuses subprocess creation;
Windows uses an invocation-specific AppContainer and direct executable launch, with a bounded
job. Private scratch and package copies are removed after use, with expired crash cleanup.
Generic inline Python remains Work-only. Schema 70 classifies content-free dispatch claims
as owner-local, portable-export excluded, delete-all included and inert in encrypted backups.
A package deleted during approval stops execution and pauses context assembly before any
new model request. No dependencies, production runtime installation, credentials, account
sign-in, deployment or existing grants change. See [skills.md](../skills.md) for exact limits,
output handling and recovery. Final verification and release evidence follow in this PR.

Step 3 local verification: `VITEST_MAX_WORKERS=2 pnpm check` passed 1,189 tests, with 21
explicit skips across 213 files (264.74 s), including lint, typecheck and secret scan.
The final focused suite passed 55/55 (17.18 s), covering selectors, approvals, denied/stopped
execution, package deletion during approval, resource prerequisites, registry and activity.
Default Rust passed 222/222 (253.05 s); both all-target clippy configurations and formatting
passed. Server-feature full-suite results follow below.

The final isolated browser test passed (36.28 s): one denied script and one exact approved
native execution; one completed dispatch claim; zero project changes; eight synthetic
accounted requests; zero unresolved billing and zero live provider calls. Its actual system
Python runs through native validation and isolation on a throwaway background owner. The
host folder remains empty and scratch is removed. Fixture iterations exposed missing staged
synthesis replies and asynchronous request completion; these were fixed without weakening
billing or execution assertions. Native desktop startup and approval cards were captured
using an isolated database/keyring and synthetic runtime availability, without approving
or running a script on the desktop. Real isolation is covered separately by native and web
tests. Eight final captures were reviewed:

- [Native approval, light](../screenshots/m16/scripts-native-approval-light.png) and
  [dark](../screenshots/m16/scripts-native-approval-dark.png).
- [Web approval, light](../screenshots/m16/scripts-web-approval-light.png) and
  [dark](../screenshots/m16/scripts-web-approval-dark.png).
- [Web completion, light](../screenshots/m16/scripts-web-completed-light.png) and
  [dark](../screenshots/m16/scripts-web-completed-dark.png).
- [Mobile completion, light](../screenshots/m16/scripts-web-mobile-completed-light.png) and
  [dark](../screenshots/m16/scripts-web-mobile-completed-dark.png).

[Recorded counters](../screenshots/m16/scripts-web-result.json) identify the fixture boundary.
Windows native isolation, current-commit CI and release evidence follow after verification.
Existing crowded mobile composer controls remain an M19 integrated layout check; the new
script card/result remains within the viewport. Released runtime/provider owner acceptance
is separate and remains pending.


Output delivery also reuses the existing explicit `keep` path: approved source/destination
mappings save only successful bounded outputs into existing granted folders, with binary
undo. The interpreter gains no folder access. Stop, resource failure or changed execution
scope suppresses saves. Selector coverage rejects traversal, absolute/duplicate destinations
and excessive mappings; a run-level test saves bytes and undoes them, and a cancellation
regression retains the original file. Final checks after this addition follow below.
Server-feature Rust passed 236/236 (287.60 s), preserving all existing benchmarks. A final
native sibling-module import check verifies supporting Python files beside the selected
entry, followed by relevant clippy/checks on the final code.

Final shared verification passes after output-save and database-driven Stop coverage:
`VITEST_MAX_WORKERS=2 pnpm check`: 1,192 passed, 21 skipped; 203 files passed, ten skipped
(247.16 s). Lint, typecheck, formatting and secret scan passed. A prior full run under native
build/screenshot load passed 1,191 tests and hit the existing one-second sign-in timeout;
its assertion was retained and the isolated full rerun passed. Focused verification passed
68/68 (11.83 s). Native final isolation/integrity/claim tests passed 5/5 in each build
(default 2.66 s; server 2.11 s), including sibling-module imports and denied executable
replacement, with both all-target clippy configurations clean. The existing HULK benchmark
passed 5/5 (14.69 s). No real provider calls or production state were used.

Final production web/runner builds pass and contain no scripted fixture markers. The latest
server binary passes the complete shared web scenario 2/2 (41.76 s). Alongside the no-save
scenario, a second approved invocation saves exactly `kept-result.txt` with bytes `42`
through FUSE's existing write path; UI Undo removes it and restores the empty granted folder.
Across all three requests (one denied, two approved): two completed native claims, one
recorded file change subsequently undone, twelve synthetic accounted requests and zero
unresolved billing. Scratch is empty after completion. These are fixture costs, not provider
charges. The final output approval/source/destination and saved-file captures were reviewed:
[approval light](../screenshots/m16/scripts-web-output-approval-light.png),
[approval dark](../screenshots/m16/scripts-web-output-approval-dark.png),
[saved output light](../screenshots/m16/scripts-web-saved-output-light.png),
[saved output dark](../screenshots/m16/scripts-web-saved-output-dark.png).
[Save/undo counters](../screenshots/m16/scripts-web-saved-output-result.json) distinguish the
recorded change from net filesystem changes. The final native dark capture was refreshed after
all source/build changes and reviewed, avoiding development hot-reload affecting the evidence.
All twelve final native/web captures show their labelled themes and were reviewed.

The first CI run on `9fe71753186aba1ffd64349b9bfab266981a7279`
([42062183725](https://github.com/isaacholt-hash/fuse/actions/runs/42062183725)) passed the
shared gate but exposed two platform issues. Linux passed 234/236: the two real script
isolation tests could not initialize bubblewrap because Ubuntu's AppArmor user-namespace
restriction blocked loopback setup. CI now installs a profile permitting user namespaces
only for its system bubblewrap executable, and runs an actual startup probe. The setup
refuses execution outside an ephemeral GitHub-hosted Linux runner; installed desktop/HULK
configuration is untouched. This follows Ubuntu's
[documented application-specific profile](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions),
without disabling the system-wide restriction or skipping the isolation tests.

Windows sandbox tests passed 11/12; the new direct-launch test failed before execution with
OS error 203. The selected executable is now canonicalized to a native Windows path, the
fixture uses native path components, and launch errors identify the failing API stage.
CI retains the sandbox unit log immediately so failures remain diagnosable while later
compatibility checks continue. A fresh current-commit run is required before merge.

The immediate Windows artifact on the second CI head locates error 203 at `CreateProcessW`;
path normalization alone did not resolve the system-utility probe. The probe now compiles a
fixed native helper with the already-required Rust toolchain and launches it under the same
OS-environment allowlist as production Python. It verifies literal quoted/Unicode arguments,
read-only package access, exclusion of another invocation's grant, denied writes/child
processes and absence of unapproved environment names. This removes dependence on a system
utility's parsing/startup assumptions while retaining and strengthening the isolation checks.
Windows execution still requires a passing current-head CI result before merge.

Current-head CI on `b052227` passed all twelve Windows sandbox tests (1.68 s), including the
new direct-launch isolation probe, and both Windows clippy steps. Shared checks and the new
script browser scenario passed. The later named-skills browser fixture exposed a test-server
collision: review, script and library fixtures all used port 4214, while an earlier server was
still exiting. Retained logs identify `Address already in use`; no product assertion is
removed. The three fixtures now use distinct ports, reject occupied endpoints, check their
own child during readiness and wait for bounded shutdown. Only each fixture's own PID is
signalled; production services are untouched. The complete sequence and fresh CI are required
before merging.


Step 3 shipped in [PR #308](https://github.com/isaacholt-hash/fuse/pull/308), merged
2026-11-05T17:02:17Z as `0a34c3f4886141a3ff36b934ce1c47a38a9cae54`. All five gates and the
JSON gate passed on `98f92cdd9283ffa5f52c3a03f3b34b762beff0bb` in
[CI 42068411542](https://github.com/isaacholt-hash/fuse/actions/runs/42068411542), with CLEAN
merge status and no unresolved reviews/comments. Shared checks: 1,192 passed, 21 explicit
skips (211.78 s); server Rust 236/236 (246.10 s). Windows sandbox 12/12, sync 31/31, atomic
files 9/9, review 4/4, skill integrity/replay 3/3 and connectors 41/41. Windows click-through
passed 16 with 22 explicit environment-only skips. Both Windows research themes and all ten
new CI script captures were reviewed. Existing benchmarks passed: dictation 31; HULK five;
sync 16 at schema 70 (40,186 ms); research eight Linux/HULK (22,352 ms), six Windows (14,952 ms)
and two explicit Linux-only Windows skips. Native/background-owner script web passed 2/2
(17.29 s). [v0.1.226](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.226) published
2026-11-05T17:11:40Z from that merge via
[release 42070618229](https://github.com/isaacholt-hash/fuse/actions/runs/42070618229).
All eleven assets and seven updater entries matched published signature files. No deployment,
installation or live activation occurred.

Step 4 adds bounded, approval-gated child execution through the existing run engine, with
native raw-object worktree preparation, owner-local claims, narrow OS command isolation and
atomic root-cap reservations/receipts. Parent stop propagates; startup retains interrupted
work and never replays it. Parent conversation cards present each exact child's approval.
Children cannot inherit project command/network grants, recursively delegate or use Git.
[parallel-code.md](../parallel-code.md) records limits, permission and retention boundaries.
Schema 71 classifies portable parent links and local claims; no dependencies were added.
Dedicated progress/review and approved integration remain step 5. Final verification follows.

Step 4 native verification passes: default 231/231 (394.74 s), server 245/245 (450.71 s),
including the preserved encrypted-sync benchmark. Both all-target clippy configurations and
formatting pass. The native worktree suite passes 8/8 separately (12.52 s). Its fixed Git probes
verify omitted secret-looking blobs, disabled filters/hooks, an unchanged dirty parent,
concurrent preparation, durable Stop, bounded growth and safe global deletion. The new sync
regression stages a completed child until its parent arrives, grants no folders or execution
and withdraws both histories on project privacy changes. An initial fixture replay attempted
to insert an already staged event ID; fixture delivery now tracks previously delivered IDs,
matching transport deduplication without weakening the dependency/privacy assertions.

Focused shared verification passed 44/44 (13.05 s), including actual child-specific command
and network approvals, existing project-command grants, no lasting permission widening, shared
reservations, unknown billing and interruption. UI clicks and keyboard answers retain the
displayed child ID; stale sibling cards cannot answer the next child's question. Production
UI and standalone runner builds pass and exclude all synthetic fixture markers. Final full
application checks, native screenshots and updated browser counters follow below.

The first full application run passed 1,212 tests with 21 explicit skips and failed the
registry's schema-coverage assertion: the new bounded task schema used array/string length
keywords outside the shared validator's supported subset. The validator now enforces those
bounds, including Unicode code-point length, with rejection/acceptance coverage. The focused
rerun passed 42/42 (5.43 s); the full check is rerun before shipping. The assertion remains intact.

The final complete application check now passes: 1,214 tests, 21 explicit live/manual or
opt-in skips across 216 files (253.86 s). Lint, formatting, type checking and the secret scan
pass. Native Rust source is unchanged from the passing full suites. No dependencies were
added and no existing test assertion was relaxed.

Final production UI and runner builds pass after the validator fix, excluding every synthetic
fixture marker. The final shared browser run passes 2/2 (43.46 s) against the rebuilt native
server: two independently approved child file edits, two completed local claims and separate
results after caller disconnection. Across the denied and approved proposals it records
14 synthetic agent requests / 2,400 micro-dollars; root aggregates equal request-ledger spend,
with no unknown billing. The parent retains its exact dirty file and original single commit.
No integration, push or real provider call occurs. The preserved HULK benchmark passes 5/5
(12.62 s). All eight final shared web captures were reviewed:

- [Task approval light](../screenshots/m16/children-web-approval-light.png) and
  [dark](../screenshots/m16/children-web-approval-dark.png).
- [Individual child approval light](../screenshots/m16/children-web-child-approval-light.png) and
  [dark](../screenshots/m16/children-web-child-approval-dark.png).
- [Completed light](../screenshots/m16/children-web-completed-light.png) and
  [dark](../screenshots/m16/children-web-completed-dark.png).
- [Mobile completion light](../screenshots/m16/children-web-mobile-completed-light.png) and
  [dark](../screenshots/m16/children-web-mobile-completed-dark.png).

[Recorded counters](../screenshots/m16/children-web-result.json) state the fixture boundary.
The 9.9.9 updater banner is fixture data, not the release identifier. Existing crowded mobile
composer controls remain an M19 layout check; new approval/result content stays within the
viewport. Native capture iterations correct click position and scroll the approval into view;
only the final reviewed captures are used for acceptance below.

Final native startup and task/base/cap approval captures were reviewed in both themes:
[light](../screenshots/m16/children-native-approval-light.png) and
[dark](../screenshots/m16/children-native-approval-dark.png). They use isolated databases,
keyrings, a disposable Git repository and synthetic model replies, without approving child
execution on the desktop. Real native worktrees and background execution are verified by the
native and web fixtures separately. All ten final native/browser images are committed.
Windows native execution and current-head CI remain required before merge. The normal release
is verified after merging.

The first CI head, `80b9fdabaf6b086bd4db0f681407a7b44f72cc42`, passed four gates in
[CI 42085633545](https://github.com/isaacholt-hash/fuse/actions/runs/42085633545). The new Windows
native worktree suite passed 3/7 and failed four cases during preparation, before file grants
or commands. Its immediately retained `windows-child-worktree-log` prevents loss of evidence.
Local Windows paths returned by canonicalization are now normalized through the existing
Windows path adapter before passing them to Git; authority still uses resolved roots. Rust
[documents this command-line interoperability boundary](https://doc.rust-lang.org/std/fs/fn.canonicalize.html).
Fixed operation names improve diagnostics without exposing Git stderr or repository paths.
Preparation assertions now require ready worktrees before later native probes, including the
concurrent/deletion cases. No assertion is skipped or weakened. Both local all-target clippy
configurations and all eight Linux worktree tests pass after the change (12.77 s); a fresh
Windows/current-head five-gate run remains required before merging.

The Windows path adapter also verifies that ordinary spelling resolves back to exactly the
same directory, refusing ambiguous trailing-dot/space components. A Windows regression creates
two distinct directories whose ordinary spellings could alias, then requires refusal. This
keeps the original folder authority intact while fixing command-line compatibility. Updated
local default/server all-target lint checks and eight Linux worktree tests pass (12.32 s).
The new Windows alias test and private-command probe require current-head CI verification.

The next Windows run verified preparation and path scope (7/8 native cases passed), including
real worktrees, raw-object exclusion, retained failures and the alias regression. Its remaining
private-command case rejected an environment variable name after launching the shell. The
launcher still passes only six selected OS variables; the fixture now distinguishes known
shell-created metadata/current-drive entries from inherited application variables, reports
names without values, and CI supplies an ambient synthetic sentinel that must remain absent.
The private-command probe must pass before merge; no production allowlist was expanded.

The same run's Windows click-through trace retained database lock errors during overlapping
read-watermark updates and a stale startup restore overriding a newly selected Chat draft.
Automatic read marks now depend on scalar run revisions, compare their observed watermark,
never regress it and preserve explicit unread marks. A future-dated result settles once.
Startup restoration yields to explicit navigation, including a new draft whose selected ID
is null. Three controlled deferred-write hook regressions plus a delayed startup/navigation
regression pass. The checklist waits for the actual Code run before its Going dot and waits
for Chat/new-draft transitions before research; watchdog and research assertions remain intact.
No dependencies, permissions, migrations or portable-data classifications change in these fixes.
Fresh complete application checks and native/web verification follow before the next CI head.

The complete application rerun after the Windows UI fixes passes 1,218 tests in 207 files,
with 21 existing opt-in/live cases skipped in ten files (251.61 s). Lint, formatting, type
checking and the secret scan pass. The initial Windows failures and their screenshots/logs
remain retained rather than replaced by the rerun. Native production behavior remains the
verified path-scope fix; the changed Windows fixture reports names only and tests rejection
of a synthetic inherited variable. Current-head Windows execution is still required.

The final current-source production UI/runner builds pass and exclude fixture markers.
Fresh native approval captures and all eight shared browser captures were reviewed in both
themes and replaced in the committed evidence set. The real browser fixture passes 2/2
(42.47 s): 14 synthetic requests, 2,400 micro-dollars, two independent changes, exact root/ledger
agreement, no unknown billing and no integration or push. The parent retains its original
dirty file and commit after caller disconnection. The preserved HULK benchmark passes 5/5
(12.43 s). The next current-head CI run must verify all Windows fixes before merge.

The following CI run passes the shared gate (1,218 tests, 21 skips), full Rust server
suite and Windows click-through (16 passed, 24 explicit skips). Windows no longer shows the
repeated SQLite lock errors, and the watchdog/research behavior passes. Screenshot review
nevertheless caught a compositor race: a research image labelled light still showed dark.
The checklist now waits for theme painting and asserts the requested theme before capture;
this changes no application behavior. Its lint/type checks pass, and a fresh current-head
five-gate run is required for the corrected Windows evidence.

Windows native child verification now passes all 8/8 cases (56.99 s) in
[CI 42093474233](https://github.com/isaacholt-hash/fuse/actions/runs/42093474233). Its redacted
probe records only the selected OS names, private temporary names, COMSPEC/PROMPT and the
current-drive entry; the synthetic inherited sentinel is absent. Parent/sibling file denial,
separate writable worktrees, path authority and retained failures all pass. This is real
Windows execution evidence; the screenshot-only follow-up still needs its own full CI gate.

Step 4 shipped in [PR #310](https://github.com/isaacholt-hash/fuse/pull/310), merged
2026-11-05T19:49:06Z as `b497bc09130a1a87c84c9e121eff12a10e56a3e0`. All five gates passed
on `68e149ced8c1d1681bb1361100b6aa0dad9daab7` in
[CI 42095349281](https://github.com/isaacholt-hash/fuse/actions/runs/42095349281), followed by
the JSON gate, CLEAN merge state and no unresolved reviews/comments. Current CI passes:
1,218 shared tests (21 skips), 245 server Rust tests, eight Windows native child tests,
32 sync compatibility, nine atomic installation, four review, three script, 41 connector
and 12 sandbox cases. Windows click-through passes 16 with 24 explicit skips; current
research setup/completion and dictation images were reviewed in both themes after fixing
the capture race. All eight current parallel web images were reviewed, including mobile.

Preserved CI benchmarks: HULK 5/5 (11.84 s); encrypted sync 16 scenarios at schema 71
(33,884 ms); research eight Linux/HULK scenarios (20,060 ms), six Windows scenarios
(14,208 ms) with two Linux-only server skips. Real parallel web verification passes 2/2
(17.99 s): 14 synthetic requests, 2,400 micro-dollars, exact root/ledger agreement, two
separate child changes, no unknown billing, unchanged parent and no integration/push.
Normal [release 42097508738](https://github.com/isaacholt-hash/fuse/actions/runs/42097508738)
is building; publication and actual assets must be verified before step 5 ships.

Step 5 integration uses a new reviewed integration branch/worktree. Its commit joins the
selected exact child commits on the pinned parent base. The approval names those revisions;
changed inputs and conflicting files pause. The original folder, its index and dirty files
stay intact. The resulting branch can be reviewed and used through the existing Code/Git
workflow; creating it never pushes or publishes a PR. Failed worktrees and claims remain
available for diagnosis, with no automatic execution or integration replay after restart.

Step 4 normal release [v0.1.227](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.227)
was published 2026-11-05T19:59:06Z by release 42097508738. Its exact source commit, eleven
nonempty assets and seven updater entries matched their published signature files. No
installation, production deployment, enrollment or owner acceptance was performed.

Step 5 adds child plans/progress/cost and explicit native commit/integration review. Schema 72
stores owner-local review snapshots and mutation journals, excluded from sync and portable
export; backup/deletion classifications are explicit. Application-authored commits use raw
objects, fixed Git arguments and compare-and-swap refs, with no hooks or checkout filters.
Reviews pin parent revision/fingerprint/index, child revision and file bytes. Unsupported
links, secret paths, oversized/binary changes, conflicts and stale inputs fail closed.
Lost caller responses are recovered from the retained owner journal without replaying work.
Global deletion refuses an active reviewed mutation and removes only app-owned worktree bytes.

The complete application check passes 1,229 tests in 211 files, with 21 existing opt-in/live
cases skipped in ten files (254.92 s); lint, formatting, type checking and secret scan pass.
The focused shared suite passes 49 tests, including combined reservations, scoped Stop,
inherited Best planning, explicit review/selection and actionable native refusal messages.
Fresh native startup and the child review dialog were exercised in both themes using only
throwaway repositories, private databases/keyrings and synthetic model replies. Reviewed
captures are in `docs/screenshots/m16/integration-native-*.png`. These checks do not establish
live provider quality or released owner acceptance.

Final step-5 validation passes Clippy for both feature sets/all targets, formatting for the
main and Windows helper crates, 238 desktop Rust tests (426.42 s) and 252 server Rust tests
(477.67 s). Fresh production desktop/web/runner builds pass and exclude fixture markers.
The recorded parallel benchmark passes 15 native cases, 49 shared cases and three browser
scenarios (59.08 s), taking 110,082 ms total at schema 72 / catalog price version 2026-10-27.
Its 16 synthetic requests total 2,880 micro-dollars, exactly matching the sum of root totals,
with no unknown billing. Both children commit after review; one exact selected child is
integrated after conflict and stale-parent refusals. The original dirty file, index and HEAD
remain unchanged. Cancellation creates no commit; an interrupted acknowledgement is
confirmed from the durable journal. Review/integration adds no provider request or push.

The preserved HULK benchmark passes 5/5 (13.47 s). All 24 final browser captures, including
mobile layouts and light/dark review, conflict, stale-input, recovered-acknowledgement and
completion states, were reviewed alongside the native captures. Evidence is in
`docs/screenshots/m16/integration-*`. The local recorded benchmark identifies implementation
commit `85e2f14b9177ca488ad9dbedebed7276a658768e`; its dirty flag reflects the pending
README/CLAUDE milestone transition. These final evidence/documentation changes require the
current-head CI run, including Windows and the preserved encrypted-sync benchmark, before
merge. No live owner acceptance or installation was performed.

The first step-5 CI attempt (42108997647) stopped at Prettier on the two newly copied
benchmark evidence JSON files. Their formatting is corrected without changing values or
application behavior. A fresh full five-gate run on the corrected commit is required.
