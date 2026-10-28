# M2 — Full P1

**Goal:** the rest of P1 that matters day to day, so FUSE passes the P1 gate. Isaac chose all four remaining areas (2026-10-28). The order follows what bites most often: daily-use gaps, then cost control, then knowledge and files, then artifacts (the largest). Each feature ships as its smallest useful version first.

**Done when:** the P1 gate in requirements §3: two straight weeks on FUSE instead of ChatGPT and Claude.

**Out of scope for M2** (planned for M3, the rest of P1):
- app lock (SE-03)
- full export and delete-all (SE-07)
- command palette and global hotkey (CH-08, PL-07)
- ChatGPT and Claude imports (PL-08, PM-08)
- compare mode and side-by-side view (RT-12, CH-17)
- prompt library (CH-12)
- LaTeX and Mermaid inside chat (CH-01)
- per-message and per-project pins (RT-01)
- the Cheap-model classifier fallback (RT-02)

Voice, agents, image generation and the web version stay in P2/P3.

## Steps (one PR each, in order)

- [x] **0. M2 plan.** This file, and CLAUDE.md pointed at it. M1's trial week skipped (2026-10-28).

### Daily-use gaps

- [x] **1. Provider notes for M2.** Extend `docs/providers.md` from the current official docs: prompt caching on both providers (prefix rules, minimum sizes, TTLs, prices), reasoning-effort and thinking-budget parameters, embedding models and prices, and retryable error and overload codes. Prices go into `data/models.json` with `verified_on` dates.
- [x] **2. Message actions (CH-07).** Copy an answer, thumbs up/down (stored per message), quote into the composer. A thumbs-down offers "Try a stronger model".
- [x] **3. Edit and regenerate with branches (CH-04).** Edit any question or regenerate any answer; both create a branch on the `parent_id` tree. A branch picker (‹ 1/2 ›) switches between siblings. "Try a stronger model" then works on any answer, not just the latest.
- [x] **4. Thread search (CH-02).** Full-text search across all chats (SQLite FTS5; first check it's in the SQLCipher build). Results open at the matching message.
- [x] **5. Incognito chat (CH-15).** Not saved to history, no memory read or write, clearly marked.
- [x] **6. Provider failover (MM-06).** On 429, 5xx or a timeout after retries, the answer moves to the same tier on the other provider, says so on the answer, and logs it. Provider status shows in the composer.
- [x] **7. Long threads (PM-06, RT-05).** A context meter in the composer. When a thread nears the window, older turns are replaced by a rolling summary from the Cheap tier (`purpose: summary`); attachments and the latest turns are kept.

### Cost control

- [x] **8. Prompt caching (RT-07).** Instructions, memory and documents go in the cacheable prefix, ordered for the most reuse. Cache hit rate shows per thread.
- [x] **9. Reasoning control (RT-08).** The router sets reasoning effort from complexity; "Think harder" in the composer forces the maximum for one message.
- [x] **10. Usage dashboard (CO-02).** Spend by day, week and month; by provider, model, tier, project and intent; against the previous period.
- [x] **11. Budgets (CO-03, RT-10, CO-07).** Monthly and daily budgets, global or per project; alerts at 50, 80 and 100%. At 80% Auto drops a tier, never below the floor; at 100% every send asks first. Plus the anomaly alert (a day's spend over 3× the trailing 14-day average).
- [x] **12. Savings and cost preview (CO-04, CO-05).** Monthly savings report: actual spend against the same requests on Best and a subscription baseline Isaac enters. Cost preview with options before any request over 20k tokens.

### Knowledge & files

- [x] **13. Embeddings + local vector index (MM-11).** sqlite-vec alongside SQLCipher; an embedding model per provider; calls logged as `purpose: embed`. **Isaac decides in that PR:** provider embeddings (recommended: cheap and simple) or a local model.
- [x] **14. Retrieval over large files (FK-02, FK-03).** Big files are chunked and indexed instead of refused; answers cite file and page; whole-file versus retrieval can be overridden per file.
- [x] **15. Project knowledge (PM-09).** Files attached to a project, indexed once, available to every chat in it, with index status and cost.
- [x] **16. Memory and history recall (PM-04, PM-10).** Memories found by meaning as well as keywords; "what did we decide about X" searches past chats and cites the thread.
- [x] **17. URL fetch (FK-06).** A pasted link is read as text (no scripts), cached for 24 hours, with a size cap and a cost estimate.

### Artifacts

- [x] **18. Artifacts v1 (AR-01).** Long or structured output (Markdown documents, code files) opens in a side panel; the model is instructed when to make one.
- [x] **19. Versions (AR-02).** Every edit is a new version: a list, a diff between any two, restore.
- [x] **20. Ask AI to edit (AR-03).** Select text, "edit this": it routes like a message, shows its cost, and the result is a new version with the diff highlighted.
- [x] **21. Live preview (AR-05).** HTML, React, SVG and Mermaid render in a sandboxed frame with no network by default.
- [ ] **22. Export (AR-04).** Download, copy, save to a folder; Markdown also exports as .docx and .pdf.

## Notes

- Follow-ups from step 21: React previews (need a bundled React and a JSX transform inside the sandbox) and AR-05's per-artifact switch to allow listed CDNs.
- Follow-up from step 14: search inside large PDFs (needs a local PDF text extractor; PDFs are still sent whole, up to 100 pages).

- Each step keeps the M1 rules: one PR, tests, screenshot, secret scan, CI green, then merge.
- Provider facts change monthly: step 1 is verified against the live docs, and every price keeps a `verified_on` date.
- Optional routing follow-ups from M1, any time Isaac asks: send hard creative and long-document requests to Best (one line in `data/routing.json`); replace the near-duplicate prompts in his test set.
