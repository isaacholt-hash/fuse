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
- [ ] **2. Named skills.** Import instruction packages and supporting files; invoke by a distinct named command, preserve provenance/version and reuse prompt/context assembly. Packages confer no permissions.
- [ ] **3. Skill scripts.** Run explicitly invoked package scripts only through the existing sandbox, permissions and approvals, with safe package paths and bounded outputs. No automatic execution on import.
- [ ] **4. Child execution.** Add parent/child runs with isolated worktrees, a single execution owner and atomic reservations against one combined cap. Stop propagates; no recursive delegation.
- [ ] **5. Parallel controls and integration.** Show child plans/progress/cost and combined spend. Require approval for exact child commits before integration; changed parents/conflicts pause. Preserve failed-run evidence and finish benchmark/screenshots/documentation.

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
