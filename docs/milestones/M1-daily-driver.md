# M1 — Daily driver

**Goal:** Isaac uses FUSE instead of the ChatGPT and Claude apps for everyday work. The order follows his four blockers (2026-10-27): attachments, web search, memory/projects, then Auto routing. Each feature ships as its smallest useful version first.

**Done when:** Isaac goes a full week without opening ChatGPT or Claude (the P1 gate in requirements §3 is two weeks; that comes after M1).

**Out of scope for M1:** artifacts/canvas, branches (edit/regenerate), compare mode, retrieval over large files (FK-02, needs sqlite-vec), full-text thread search, voice, agents. Plan them in M2.

## Steps (one PR each, in order)

- [x] **0. M1 plan.** This file, and CLAUDE.md pointed at it.
- [x] **1. Provider notes for M1.** Extend `docs/providers.md` from the current official docs: image and PDF input for both providers (formats, size and page limits, how they're billed), native web search tools (how to enable, citations format, price per search, data handling), and system prompts. Prices for search go into `data/models.json`.
- [x] **2. Image attachments.** Paste, drag-and-drop and file picker for PNG/JPG/WebP/GIF in the composer; thumbnail, size and estimated tokens before sending; stored locally (`attachments` table per `docs/data-model.md`); sent to both adapters. Models without vision are greyed out in the picker while an image is attached (FK-04).
- [x] **3. Document attachments.** PDFs sent natively where the provider supports it; TXT, Markdown, CSV and source code inlined as text; DOCX extracted to text. Show tokens and cost estimate before sending. Files over the whole-file limit are refused with a clear message (retrieval is M2).
- [x] **4. Web search.** A per-message toggle in the composer (remembered per thread) that turns on the provider's native search tool. Sources render as citations under the answer; the search fee is added to the answer's cost and to the request log.
- [x] **5. Custom instructions.** Global "about you / how to answer" and per-thread instructions (CH-05); the effective set is viewable from the thread header.
- [x] **6. Projects.** Create, rename, delete; project instructions and default model; threads belong to a project and can be moved; sidebar groups by project (PM-01, without knowledge files).
- [x] **7. Memory v1.** Facts you can see, add, edit and delete (PM-02, PM-07). After a thread, a Cheap-tier model proposes facts; you approve them (PM-03). The secrets filter never stores keys or passwords (PM-05). Injection uses keyword match within a token budget (PM-04); vector search comes in M2.
- [x] **8. Auto-title.** Titles from the Cheap tier after the first exchange (CH-09), logged as `purpose: title`.
- [x] **9. Tiers and routing policy as data.** `data/routing.json`: tier → models (Cheap / Balanced / Best), quality floor per intent (RT-17), the default rules (RT-03). Built from the current catalog; **Isaac approves the tier mapping** in the PR.
- [x] **9a. Golden prompt set.** Isaac picks 50 real prompts from his ChatGPT/Claude history with the tier he'd expect (RT-16). Claude builds the import helper; Isaac supplies the prompts.
- [x] **10. Auto routing.** Composer mode Auto / pinned tier / pinned model (RT-01); local heuristic classifier (RT-02), checked against the golden set; every answer shows tier, rule and "would have cost $X on Best" (RT-09).
- [x] **11. Escalation.** "Try a stronger model" on any answer re-runs it one tier up (RT-04).

**All build steps done (2026-10-28).** What's left is the "done when": a full week on FUSE instead of ChatGPT and Claude.

## Carried from M0 (fit in where they're needed)

- [x] **C1. Content security policy.** Turn `csp` on in `tauri.conf.json` before attachments land (step 2).
- [x] **C2. Encrypted database.** SQLCipher (PL-03), before memory is stored (step 7). Attachment files in `files/` are not encrypted yet (follow-up).
- [x] **C3. Auto-update + signed builds** (PL-06), before the week-long trial. Update signing only; paid Windows code signing deferred (docs/releases.md).

## Notes

- Provider facts change monthly: step 1 is verified against the live docs, and every price keeps a `verified_on` date.
- Each step keeps the M0 rules: one PR, tests, screenshot, secret scan, CI green, then merge.
