# M3 — The rest of the P1 must-haves

**Goal:** the P1 must-haves still missing after M2: math and diagrams in chat, pins per message and per project, a command palette and global quick capture, export and delete-all, an app lock, and importing from ChatGPT and Claude. Isaac chose this scope on 2026-10-28, built unattended like M2 (merge on green, one report at the end).

**Done when:** the P1 gate in requirements §3: two straight weeks on FUSE instead of ChatGPT and Claude.

**Out of scope for M3** (planned for M4):
- **M2 follow-ups:** search inside PDFs, React previews, the CDN switch for previews (AR-05), artifacts in projects (AR-06), per-key spend caps (MM-09).
- **Smarter routing:** the Cheap classifier fallback (RT-02), learning from overrides (RT-11), compare mode (RT-12, CH-17), the editable policy with test-before-save (RT-03, RT-16), stay-on-provider and the latency tie-break (RT-06).
- **Polish:**
  - prompt library (CH-12), quoting a selection (CH-13), thread export (CH-11), pin/archive/tags (CH-02)
  - memory conflicts (PM-11), file viewer (FK-10), file secrets warning (FK-11)
  - price refresh, model discovery and deprecations (MM-03/04/08), per-model defaults (MM-07)
  - font size and reduced motion (PL-10)
- **OS biometrics for the app lock.**

Voice, agents, image generation and the web version stay in P2/P3.

## Steps (one PR each, in order)

- [x] **0. M3 plan.** This file, and CLAUDE.md pointed at it. M2 testing skipped (2026-10-28).
- [ ] **1. Math and diagrams in chat (CH-01).** LaTeX in answers (KaTeX, bundled locally), and Mermaid code fences drawn as diagrams with a Code/Diagram switch.
- [ ] **2. Pins per message and per project (RT-01, PM-01).**
  - A "this message only" pin in the picker that resets after sending.
  - A project's default can be Auto, Balanced, Best or a model, and new chats in it start on that.
- [ ] **3. Command palette (CH-08).** Ctrl+Shift+P: every action (new chat, incognito, search, settings, usage, mode, search and think toggles) and recent chats, fuzzy-matched, with their shortcuts.
- [ ] **4. Global quick capture (CH-08, PL-07).**
  - A system-wide shortcut (default Ctrl+Alt+Space) brings FUSE forward on a new chat, ready to type.
  - It can be changed or turned off in Settings, and Settings says when the desktop blocks it.
- [ ] **5. Export everything (SE-07).** A zip holding everything as JSON (chats with branches, memories, projects, artifacts with versions, instructions, budgets, usage) plus one Markdown file per chat. Never keys.
- [ ] **6. Delete everything (SE-07).** A typed confirmation wipes all data and stored files. API keys are removed only if that box is ticked too.
- [ ] **7. App lock (SE-03).**
  - An optional passcode at launch and after an idle time (default 15 minutes).
  - Only a salted PBKDF2 hash is stored, and repeated wrong tries slow down.
- [ ] **8. Import chats from ChatGPT (PL-08).** The ChatGPT data-export zip becomes chats, keeping dates and branches. You see a preview count first, and running it again doesn't duplicate.
- [ ] **9. Import chats from Claude (PL-08).** Claude's data export becomes chats and projects (with their instructions), with the same preview and no duplicates.
- [ ] **10. Import memories and custom instructions (PM-08).**
  - Paste ChatGPT's or Claude's memory list, and the Cheap model splits it into facts for the usual review, with duplicates merged.
  - Custom instructions fill the global boxes after a confirm.

## Notes

- Each step keeps the M2 rules: one PR, tests, screenshot, secret scan, `cargo fmt --check` when Rust changes, CI green, then merge.
- New dependencies are pinned to releases at least two weeks old; install scripts are allowed only in `pnpm-workspace.yaml`.
