# M17 — Writing, artifacts and context

## Delivery rules

Approved by Isaac on 2026-11-05 as part of [Finish FUSE P2](../P2-completion.md).
One `codex/m17-*` branch and PR per numbered step, sequentially from integrated main.
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

AR-07, AR-08, AG-01 completion, PM-04 P2 extension.

## Steps

- [x] **1. Scoped context tools.** Complete memory and artifact reads/mutations in the tool registry, retaining provenance/authority/review and versioning. Add artifact retrieval by meaning with keyword fallback, privacy filtering and source references.
- [ ] **2. Writing canvas.** Markdown sections, anchored comments and rewrite/shorten/expand actions. Show model changes as reviewed diffs and create a new version; protect against overwriting concurrent edits.
- [ ] **3. Python artifacts.** Run an explicitly selected artifact version with selected inputs in an isolated scratch folder using existing approval/runtime/sandbox limits. Display output beside code and retain version/attempt provenance, desktop/HULK parity, tests and release evidence.

## Behavior and boundaries

Memory writes follow existing proposal and authority rules; decisions cannot be added or
superseded automatically. Artifact mutations create versions, and retrieval respects project,
conversation and record policy. Indexes stay local and are regenerated, not replicated.

Use the current Markdown artifact editor/version system. Sections and comment anchors refer
to version UUIDs; changed anchors require review. An AI revision is a proposal against the
selected version, never a blind overwrite. Retain comments and resolutions in portable data;
export them in structured records without claiming every document format preserves them.

Python only, using the installed approved runtime. Copy explicitly selected inputs into a
restricted scratch workspace, with no network by default and current time/memory/output caps.
No arbitrary filesystem grant or repository is needed to execute a code artifact. Keep code,
output and run provenance linked; installing a runtime is explicit. Browser execution uses
HULK and explains missing runtime/unavailable ownership. Scratch coordination does not sync.

## Acceptance

Scope/provider exclusion and keyword/semantic retrieval; no blocked memory or artifact leaks.
Memory authority and review, version collisions, deleted sources, section/comment moves,
stale AI proposals and concurrent edits. Python denial, unavailable runtime, stop/timeout,
resource/network limits, selected-input isolation, invalid outputs and immutable provenance.
Recorded desktop/HULK fixtures and reviewed light/dark canvas/output screenshots.

## Evidence

Append PRs, exact checks/builds, screenshots and benchmark results as each step ships.
Step 1 implements six shared scoped tools, atomic reviewed memory proposals and UUID-pinned
artifact versions. Meaning retrieval uses conservative pre-dispatch holds and one attempt,
with visible keyword fallback; the shared assembler records recalled artifact sources. See
[context-tools.md](../context-tools.md) for scope, limits, privacy and backup/export boundaries.

The real native-storage browser fixture passes two scenarios (31.82 s) on schema 73, with one
owner-reviewed conversation memory, two artifact versions, source UUIDs, five synthetic
request receipts, no unknown billing, no runs and no folder grants. Light/dark screenshot
review caught and fixed the existing version toolbar overflow; the fixture asserts the title
and Close control remain visible. Native startup and final full checks are recorded below
before merge. Live provider quality remains an owner-operated acceptance check; fixtures
make no provider calls.
