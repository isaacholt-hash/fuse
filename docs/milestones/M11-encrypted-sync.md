# M11 — Encrypted sync

Approved by Isaac on 2026-11-04, including building and merging the steps unattended.

## Goal and trust boundary

Desktop databases and HULK converge on chats, projects, memory, app-managed files, portable settings and cost history. HULK is the trusted host **and a participant that can decrypt content** for the web app and runner. Browsers use HULK's database rather than becoming replicas. Payloads are encrypted before transfer and in the sync store; this does not protect content from a compromised participating HULK. No database-file replication.

Sync is opt-in, separately from pairing. Setup previews eligible content and merges histories, keeping record IDs. Incognito content, local-only projects, records kept on this device, credentials, app-lock state, caches and indexes never sync. Machine paths, repository contents, folder/network/command grants and MCP credentials remain local. Syncing a record never grants permission or executes work. Active runs, approvals and schedules retain their execution owner; completed replicated runs are read-only.

Portable preferences are explicitly allowlisted: memory preferences, model defaults, routing, catalog overrides and notifications. Installation state, device identity, shortcuts, model installation and temporary spending overrides stay local. App-managed attachments, knowledge files and artifact versions sync; repository and arbitrary folder contents do not.

## Build mode

One `codex/m11-*` branch and PR per step below. Use `.claude/skills/ship-step/SKILL.md`, tick the box in its PR, attach every PR to the Codex chat, merge only with all required checks and CI green, then continue. Isaac's explicit unattended authorization overrides stopping after each merge. Stop only for an unresolved product decision, unavailable required access or a failure that cannot be resolved safely. No production data, live provider keys, HULK deployment or automatic enrollment. Finish with PRs, screenshots, benchmark evidence and exact activation instructions.

## Steps (one PR each, in order)

- [x] **1. Plan and workflow.** This file; point CLAUDE.md and the roadmap here and record the unattended exception.
- [x] **2. Durable change tracking.** Forward-only migrations for device identity, replication metadata, outbox/inbox, cursors, conflicts, revisions and deletion markers. SQLite triggers cover desktop, browser and runner writes atomically; incoming apply suppresses recapture only in its transaction. Keep memory revision fields consistent. Add atomic `SqlDb.batch()` and production/test adapters; use it for related deletion/privacy writes. A central registry classifies every table, portable column, natural key and dependency; schema coverage fails for unclassified tables.
- [x] **3. Crypto, identity and enrollment.** Rust-only random workspace keys, fresh nonces, authenticated metadata and per-device signatures. Pin `chacha20poly1305 = 0.11.0` (XChaCha20-Poly1305) and `ed25519-dalek = 3.0.0` (strict verification); existing OS randomness and secret stores. Pairing plus explicit enrollment, native HTTPS key transfer, no secret keys in ordinary UI replies. Separate random sync recovery code and encrypted recovery bundle; recovery also requires HULK authentication. Without surviving keys or the code, ciphertext is unrecoverable.
- [x] **4. Transport and worker.** Authenticated versioned enrollment, status, push/pull, acknowledgements, blobs, recovery and revocation; typed records rather than remote SQL. Stable event IDs, device/sequence, causality, key epoch and protocol version; atomic cursors and idempotent retries. One worker per desktop/server, independent of views, one-second debounce, five-second poll, exponential retry capped at sixty seconds and Sync now. Pause on incompatible versions, authentication failure or malformed input without losing pending edits.
- [x] **5. Merge and history.** Causal revisions distinguish later/concurrent edits. Ordinary concurrency uses logical clock, device ID and event ID with losing revisions retained. Concurrent facts/decisions require review and are excluded from context until resolved; resolution replicates. Concurrent policies choose the restrictive result. Reconcile natural-key collisions; artifact version UUIDs identify versions, display numbers derive from deterministic order. Stage missing dependencies, apply batches atomically, never silently discard or clear required links. Deduplicate request costs by ID, preserving integer micro-dollars and surface attribution; no provider calls.
- [x] **6. Files and deletion.** Resumable authenticated encrypted chunks, names/hashes/paths only in encrypted manifests, complete-hash checks and atomic installation using local paths. Publish completed/interrupted answers and run snapshots, never streamed chunks or run coordination. Preserve the eight-second undo window; final deletion publishes content-free markers that dominate stale edits. Remove deleted payloads, revisions and unreferenced blobs; keep markers throughout M11. Retain ordinary old revisions thirty days and unresolved conflicts until resolved. Privacy withdrawal removes already-synced remote copies. Backup retention stays separate.
- [x] **7. Shared controls.** Settings → Sync: preview/enrollment, last success, pending/file progress, errors, conflicts, devices, Pause/Sync now, recovery and revocation. Both themes, keyboard navigation, desktop/web. Revocation blocks the device token and sync immediately, rotates encryption/recovery material, and distributes keys only to active devices; active offline devices re-encrypt pending work on return. Revocation cannot erase downloaded copies. Disable preserves local data; delete everywhere explicitly propagates workspace deletion.
- [ ] **8. Benchmark and release kit.** Two independent desktop-style replicas plus a throwaway HULK with synthetic data and in-memory secrets. CI including Windows compatibility, existing HULK benchmark retained. Setup, recovery, revocation, deletion, backup and update instructions; threat model updated for trusted HULK and exposed metadata.

## Acceptance

- Initial union, repeated sync, offline edits and reconnect converge without changing stable IDs or duplicating cost/run execution.
- Duplicate/reordered delivery, interrupted transfer, clock skew and crashes around commit/acknowledgement preserve pending work.
- Facts/decisions go to review; policies stay restrictive; natural-key and simultaneous artifact-version collisions lose nothing.
- Deleted or withdrawn content cannot return from a stale device. Undo, shared-file references and remote cleanup behave correctly.
- Reject corrupted files, invalid signatures, tampered envelopes, wrong workspace/epoch, revoked devices and incompatible versions.
- Recovery/rotation work; private content, credentials and machine permissions are absent from payloads; migration preserves existing data.
- Every PR: `pnpm check`; relevant Rust checks; desktop startup and screenshot plus web verification (docs-only PRs may skip screenshots); all CI green. Full benchmark runs in CI.

## Sources

- PL-04 and SE-14 in `docs/requirements.md`.
- [RustCrypto chacha20poly1305 0.11.0](https://docs.rs/crate/chacha20poly1305/0.11.0), released 2026-06-28.
- [ed25519-dalek 3.0.0](https://docs.rs/crate/ed25519-dalek/3.0.0), released 2026-07-06.
