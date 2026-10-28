# M4 — The rest of P1

**Goal:** every P1 requirement still missing after M3, Musts first and then Shoulds, so P1 is feature-complete. Isaac chose this scope on 2026-10-28, built unattended like M2 and M3 (merge on green, one report at the end).

**Done when:** the P1 gate in requirements §3: two straight weeks on FUSE instead of ChatGPT and Claude.

**Out of scope:** voice, agents, image generation and the web version stay in P2/P3.

## Steps (one PR each, in order)

- [x] **0. M4 plan.** This file, and CLAUDE.md pointed at it. M3 testing skipped (2026-10-28).

### P1 Musts still missing

- [x] **1. Pin, archive and tags (CH-02).** Pinned chats at the top of the sidebar, archived ones behind a toggle, tags from the chat header, filterable in the sidebar and search.
- [x] **2. Font size and reduced motion (PL-10).** Small, normal or large text; Reduce motion follows the OS by default.
- [x] **3. Editable price list with refresh (MM-04).**
  - Prices are editable per model, and the shipped ones stay as defaults.
  - When a price is over 30 days old, FUSE offers to refresh from the repo's `data/models.json` and shows the changes first, so prices update without a release.
- [x] **4. Model discovery and deprecations (MM-03, MM-08).**
  - The providers' model lists are read through the adapters, and models can be added by hand.
  - A tier's model that disappears or is deprecated is flagged, with a replacement suggested.
- [ ] **5. Editable routing policy with test before save (RT-03, RT-16).** A rule editor, per-project overrides, and import/export as a file. Before a change is saved, it's scored against the routing test set, before vs after.
- [ ] **6. React previews and the CDN switch (AR-05).**
  - React artifacts render in the sandbox with a bundled React and JSX transform, and no network.
  - A per-artifact switch allows listed CDNs.
- [ ] **7. Search inside PDFs (FK-02).** Big PDFs are extracted locally, chunked and indexed, and citations give page numbers.
- [ ] **8. Windows Hello unlock (SE-03).** On Windows the lock screen offers Windows Hello, with the passcode as fallback.

### P1 Shoulds

- [ ] **9. Cheap classifier fallback (RT-02).** When the local heuristics are unsure, the Cheap tier classifies, logged with its cost.
- [ ] **10. Stay on provider and latency tie-break (RT-06).**
- [ ] **11. Learn from overrides (RT-11).** Three stronger pins for the same intent suggest a rule change, shown with its test-set score. The policy never changes silently.
- [ ] **12. Compare mode and side by side (RT-12, CH-17).** One prompt to two or three tiers, with the combined cost before sending; any two answers side by side with a diff.
- [ ] **13. Prompt library (CH-12).** Saved prompts with variables, global or per project, from `/` or the palette.
- [ ] **14. Quote a selection (CH-13).**
- [ ] **15. Thread export (CH-11).** Markdown, PDF or JSON, or copy as Markdown.
- [ ] **16. Memory conflicts (PM-11).** A contradicting fact shows both and asks which stands; the old one is kept as history.
- [ ] **17. File viewer (FK-10).** Any attached file in the side panel, at the cited page or chunk.
- [ ] **18. File secrets warning (FK-11).** Before a file is sent, offer to redact keys, passwords and card numbers.
- [ ] **19. Per-model defaults (MM-07).** Temperature, max output, reasoning effort and a prompt prefix, per model, tier and project.
- [ ] **20. Spend caps per key (MM-09).** Daily and monthly caps with a hard stop and a one-click raise for today.
- [ ] **21. Artifacts in projects (AR-06).** Artifacts belong to a project, are searchable, and can be attached to any chat.

## Notes

- Each step keeps the M3 rules: one PR, tests, screenshot, secret scan, `cargo fmt --check` and clippy when Rust changes, CI green, then merge.
- New dependencies are pinned to releases at least two weeks old; install scripts are allowed only in `pnpm-workspace.yaml`.
- Windows Hello (step 8) can't be tried on HULK; Isaac tests it on Windows.
