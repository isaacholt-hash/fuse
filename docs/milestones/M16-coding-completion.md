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

- [ ] **1. Structured review.** Review pinned local changes, branches and GitHub PRs using the M15 reader. Findings carry severity, verified path/line and evidence. Reviewing edits no files and posts no comments.
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
No acceptance evidence has been recorded for this milestone yet.
