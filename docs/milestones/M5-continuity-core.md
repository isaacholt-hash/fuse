# M5 — Continuity core (P1.5 part 1)

**Goal:** FUSE owns a project's context in a provider-neutral form, so a project moves between OpenAI and Anthropic without losing its decisions or constraints (requirements §3, PM-12 to PM-19, SE-13 to SE-15, PL-11, PL-12). Isaac approved this plan on 2026-10-29, built unattended like M2–M4 (merge on green, one report at the end).

**Done when:** the two-provider continuity test (PM-19) passes, and no content reaches a blocked provider in tests. Isaac then runs `pnpm continuity:live` with his own keys for the live 90% number.

**Out of scope:** local inference and the rest of Local and lean (M6), sync (P2).

## Steps (one PR each, in order)

- [x] **0. M5 plan.** This file, and CLAUDE.md pointed at it.
- [x] **1. Backup and restore (PL-11).**
  - "Back up now" and a list of backups with Restore in Settings → Data; a restore is applied at the next start, before the database opens, and the current database is kept aside.
  - Backups stay encrypted; an integrity check re-hashes attachment files against the database.
  - A test harness upgrades a seeded database from migration 25 and checks nothing is lost.
- [ ] **2. Typed memory schema (PM-12, PM-13, PM-14).**
  - Memory records gain a kind (fact, preference, person, constraint, decision, task, source), a scope (global, workspace, project, conversation), authority (you, imported, extracted), status, provenance, sensitivity, may-send, revision and device id.
  - Existing memories are carried over; the table rebuild is proven on the upgrade harness first.
- [ ] **3. Memory screen for types, scope and provenance (PM-12 to PM-14).** Filters by kind, scope and status; provenance shown; sensitivity, may-send and expiry editable; "remember for this chat only". Extraction suggests a kind, never a decision.
- [ ] **4. Decisions (PM-15).** A project Decisions tab with rationale, alternatives, status and what it replaces. Never added automatically; a suggestion never overrides your own or imported records.
- [ ] **5. Tasks (PM-16).** A project Tasks tab with status and dependencies; extracted tasks wait for review.
- [ ] **6. Exclude and explain (PM-17).** Exclude a memory without deleting it; each answer records why each memory was used.
- [ ] **7. Context assembler (PM-18).** One module builds every request in order: instructions, constraints and decisions, tasks, memories, summaries, file excerpts, history, each part with its source. Requests without decisions stay as they were.
- [ ] **8. Egress policy in the app (SE-13, part 1).** Per project: privacy mode (Normal, Local only, Cloud only), providers allowed or blocked, embeddings on or off; per record: may-send. Blocked content is never sent, and you see why.
- [ ] **9. Egress in the Rust transport (SE-13, part 2).** Every send carries its scope; the Rust transport looks up the project and refuses blocked providers. One test per send path.
- [ ] **10. Privacy wording and threat model (SE-15, SE-14).** Settings → Privacy explains what stays local and what goes to a provider; `docs/threat-model.md`.
- [ ] **11. Export format v1 (PL-12, part 1).** `docs/export-format.md`: a manifest, records as JSON, files named by hash; export everything or one project.
- [ ] **12. Restore from an export (PL-12, part 2).** Everything or one project, a preview first, ids kept, duplicates skipped; a round-trip test.
- [ ] **13. Two-provider continuity test (PM-19).** Recorded project histories whose decisions and constraints must reach both providers' requests (automated, no API calls), plus `pnpm continuity:live` for Isaac.

## Notes

- Each step keeps the usual rules: one PR, tests, screenshot for UI changes, secret scan, `cargo fmt --check` and clippy when Rust changes, CI green, then merge.
- Rust changes are cross-checked for Windows, and the Windows release build is confirmed after merge.
- Migrations stay forward-only; the backup before every migration is the rollback path.
