# FUSE data model (P1)

The whole P1 schema, designed up front so shipped migrations never need patching. Each milestone builds only the tables it needs (the **Built in** column). Later tables and columns arrive as **new** migrations (`CREATE TABLE`, `ALTER TABLE … ADD COLUMN`); shipped migrations are never edited.

Requirement IDs refer to `docs/requirements.md`.

## Conventions (all tables)

| Rule | Detail |
| --- | --- |
| Primary key | `id TEXT` holding a **UUIDv7** (time-sortable, safe to create offline, works for P2 sync without renumbering). |
| Tenant columns | `workspace_id TEXT NOT NULL`, `user_id TEXT NOT NULL` on every table, including `workspaces` (where `workspace_id = id`) and `users`. Every query filters by `workspace_id` (SE-04). |
| Timestamps | `created_at`, `updated_at`: `INTEGER` Unix milliseconds, UTC. |
| Deletes | Soft delete with `deleted_at INTEGER NULL` on user-visible records (threads, messages, projects, memories, artifacts), so P2 sync can propagate deletes. A purge job hard-deletes after the retention window. |
| Money | `INTEGER` **micro-dollars** (`cost_micro_usd`), never floats. |
| Tokens | `INTEGER NOT NULL DEFAULT 0`: `input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_write_tokens`, `reasoning_tokens`. |
| Enums | `TEXT` with a `CHECK (col IN (...))` constraint. |
| JSON | `TEXT` holding JSON, only for open-ended data (capabilities, options). Never for anything we filter or sum on. |
| Foreign keys | Declared, with `PRAGMA foreign_keys = ON` per connection. Child rows of a soft-deleted parent stay; the UI hides them. |
| Secrets | **No table ever stores an API key.** Keys live only in the OS keychain (step 4). |

**Price versioning.** `data/models.json` has a `price_version` (the date its prices were verified, e.g. `2026-10-26`). Each priced row stores the `price_version` it was costed with plus the computed `cost_micro_usd`, so later price changes never rewrite history (CO-01).

## Tables

### Core: built in M0

| Table | Purpose | Key columns (besides conventions) | Built in |
| --- | --- | --- | --- |
| `workspaces` | Tenant. One default row in v1. | `name` | M0 |
| `users` | Person. One default row in v1. | `display_name`, `email NULL` | M0 |
| `threads` | A conversation. | `title`, `title_source` (`user`/`auto`), `last_message_at`, `deleted_at` | M0 |
| `messages` | One user or assistant turn. | see below | M0 |
| `request_log` | One row per provider HTTP call, including retries, classification and title calls. | see below | M0 |
| `schema_meta` | Backup and migration bookkeeping beyond the SQL plugin's own table. | `key`, `value` | M0 |

`messages`:

| Column | Notes |
| --- | --- |
| `thread_id` | FK → threads. |
| `parent_id NULL` | FK → messages. **Branching (CH-04) from day one:** a thread is a tree, and M0 always appends to the current leaf. Edit/regenerate later just adds siblings, with no migration. |
| `role` | `user` / `assistant` / `system`. |
| `content` | Markdown text. (Attachments and artifacts link from their own tables.) |
| `status` | `complete` / `streaming` / `stopped` / `error`. A `streaming` row left over after a crash is shown as interrupted (CH-10). |
| `error_code NULL`, `error_message NULL` | Plain-English error for the UI. Never contains request bodies or keys. |
| `provider NULL`, `model NULL` | Set on assistant rows. |
| tokens ×5, `cost_micro_usd`, `price_version`, `latency_ms`, `ttft_ms` | Usage as returned by the provider; `ttft_ms` = time to first token. |
| `request_id NULL` | FK → request_log, for the final successful call. |

`request_log`:

| Column | Notes |
| --- | --- |
| `message_id NULL`, `thread_id NULL` | Null for calls not tied to a message (key test). |
| `purpose` | `chat` / `key_test` / `title` / `classify` / `memory` / `summary` / `embed`. |
| `provider`, `model`, `attempt` | `attempt` counts 1–3 retries (MM-06). |
| tokens ×5, `cost_micro_usd`, `price_version`, `latency_ms`, `ttft_ms` | Same meaning as on messages. |
| `http_status NULL`, `error_code NULL`, `error_message NULL` | Sanitised: no headers, no bodies. |
| `provider_request_id NULL` | The provider's request id header, for support. |

Routing columns (`tier`, `route_rule_id`) were added in M1 step 10 (`0008_routing.sql`); they are NULL on housekeeping calls. Cache hits come from `cached_input_tokens > 0`, so no separate column is needed. Retention: 90 days, then purge (section 16).

### Routing and cost: M1+

| Table / column | Purpose | Req |
| --- | --- | --- |
| `messages.tier`, `messages.route_rule_id`, `messages.route_reason`, `messages.pinned_mode`, `messages.route_intent`, `messages.route_complexity`, `messages.best_cost_micro_usd` | What tier and rule picked the model, and why. `pinned_mode`: `auto` / `tier` / `model` (NULL on answers from before routing). Intent and complexity are what the classifier read (Auto only). `best_cost_micro_usd` is the same tokens priced on the cheapest Best model with a key: an estimate, since another model would use a different number of tokens. Built in M1 step 10 (`0008_routing.sql`). | RT-01, RT-09 |
| `messages.feedback` | `up` / `down` / null. Built in M2 step 2 (`0010_feedback.sql`); a thumbs-down on the latest answer highlights "Try a stronger model". | CH-07, RT-11 |
| `messages.escalated_from_id NULL` | The answer this one re-ran one tier up ("Try a stronger model"). Built in M1 step 11 (`0009_escalation.sql`). Both answers stay in the thread and both count in its cost; history sent to models skips any answer that was re-run, so later turns carry the stronger one. Offered on the latest answer only (earlier ones need branching, M2). Logged with `route_rule_id = 'escalation'`. | RT-04 |
| `request_log.tier`, `request_log.route_rule_id` | Same as above, per call. | RT-09 |
| `threads.pinned_tier NULL`, `threads.pinned_model NULL`, `threads.pinned_provider NULL` | Per-thread pins: a tier (`balanced`/`best`) or a model; all NULL = Auto. Built in M1 step 10; chats from before it start on Auto. Per-project defaults (a tier or a model) and a "next message only" pin in the picker were added in M3 step 2. The one-message pin is never stored: it applies to one send, then the chat's mode is back. | RT-01, RT-06 |
| `budgets` | `scope` (`global`/`project`), `project_id NULL`, `period` (`day`/`month`), `limit_micro_usd`, `hard_stop`, `allow_until NULL` (the temporary raise). Built in M2 step 11 (`0015_budgets.sql`). Spend is the request log since the period started (local midnight or the 1st), project spend through the call's thread. From 80%, Auto routes one tier lower, never below the floor and never for a pinned tier. At 100%, a send asks first (Send anyway, or Allow for the rest of this period); with `hard_stop`, only the raise can unlock it. Per-key caps (MM-09) aren't built. | CO-03, MM-09 |
| `budget_events` | Alerts fired (50/80/100%, anomaly), so each one shows once: `budget_id NULL` (null for the anomaly), `kind`, `period_start`. Built in M2 step 11. Checked after every answer; only the highest level reached shows. The anomaly is a day's spend over 3× the average of the previous 14 days. | CO-03, CO-07 |
| `golden_prompts` | Eval set: `prompt`, `expected_tier` (`balanced`/`best`), `intent`, `complexity`, `needs_context`, `notes`, `position`. Built in M1 step 9a (`0007_golden_prompts.sql`), imported from a JSON Lines file in Settings; an import replaces the set. `rating` is left out until something uses it. | RT-16 |

The routing policy, tiers, model catalog and prices are **data files** in `data/`, not tables. User edits to them are saved as override files, not rows.

**`data/routing.json`** (M1 step 9, `src/routing/policy.ts`): three tiers in order (Cheap, Balanced, Best), each a list of `provider/model-id` from `data/models.json`; within a tier the app picks the cheapest model for the request's input size, ties going to `provider_preference`, then the chat's provider. `housekeeping` maps titles, classification, memory and summaries to a tier. `quality_floor` is the lowest tier allowed to answer per intent and complexity (RT-17). `rules` are first-match-wins (intent, complexity, capabilities, context size → tier, with a `reason` shown on the answer); the last must match everything. Neither a rule nor a floor may name Cheap: the file is refused at startup.

**Auto routing** (M1 step 10, `src/routing/classify.ts`, `src/routing/route.ts`): before each send a local classifier reads the question (length, code, attachments, keywords) as an intent and complexity. The first matching rule picks a tier, never below the floor. The cheapest model in that tier with a key and the needed capabilities answers. If none qualifies, the next tier up is tried; routing never moves down. The Cheap-model fallback for unsure classifications (RT-02) is not built yet. Settings → Routing test set scores the classifier against the imported prompts.

### Projects, instructions, threads: M1+

| Table / column | Purpose | Req |
| --- | --- | --- |
| `projects` | `name`, `instructions`, `default_tier NULL`, `provider_preference NULL`, `quality_floor_json NULL`, `deleted_at`. Built in M1 step 6 (`0005_projects.sql`) with `name`, `instructions`, `default_provider`/`default_model` (both NULL = new chats start on Auto; set = new chats in the project are pinned to that model since step 10; `default_tier` (`balanced`/`best`) added in M3 step 2, `0020_project_tier.sql`; a default model wins over it) and `deleted_at`. Deleting a project keeps its chats (they move out to no project). | PM-01, RT-17 |
| `threads.project_id NULL` | FK → projects. Threads can move between projects. Built in M1 step 6. | PM-01 |
| `threads.instructions NULL` | Per-thread custom instructions. Global instructions live in `settings`. | CH-05 |
| `threads.pinned`, `threads.archived_at NULL`, `threads.incognito` | Incognito threads never touch memory and aren't listed. `incognito` built in M2 step 5 (`0013_incognito.sql`): created with memory off, never auto-titled, hidden from the sidebar and search, and purged (`purgeThread`: messages, file links, citations, memory links, the thread) when you leave it or at the next start. Request-log rows stay for cost, unlinked (they hold no text). Attached file bytes stay on disk until a later cleanup. `pinned` and `archived_at` not built yet. | CH-02, CH-15 |
| `thread_summaries` | Rolling summary of a long thread's older turns (PM-06, RT-05): `thread_id`, `upto_message_id` (last message it covers), `summary`. Built in M2 step 7 (`0014_summaries.sql`). After an answer, once the tokens it took in and gave out pass 75% of the answering model's window (or 90% of a long-context price threshold, whichever is lower), the housekeeping model (`purpose: summary`) merges the previous summary with everything but the latest 6 messages. From then on the model gets the summary at the end of its system prompt, every turn that had attachments in full, and the messages after `upto_message_id`. A summary applies while its message is on the thread's path, so branches keep their own. The chat shows a dashed divider where the summary ends, and the composer shows a context meter. | PM-06, RT-05 |
| Recall (no new table) | M2 step 16. **Memories by meaning (PM-04):** when the memories in scope don't fit the budget and there's an OpenAI key, each memory is embedded (`chunks` with `source_kind = 'memory'`, re-embedded after an edit) and its similarity to the question is added to the keyword score. **Past chats (PM-10):** a question like "what did we decide about X" or "remind me what we said" runs a full-text search (`messages_fts`) on its topic words across other non-incognito chats. Up to 6 matching messages (2 per chat) go with the question, each with the chat's title and date. The answer lists the chats under "From your files and chats" (`message_citations` `kind = 'chunk'`, `chunk_id = 'thread:<id>'`). | PM-04, PM-10 |
| `web_pages` | Links read for chats (FK-06): `url`, `file_id`, `title`, `fetched_at`. Built in M2 step 17 (`0018_web_pages.sql`). Pasting a link into the composer reads the page through `url_fetch` (`src-tauri/src/web.rs`): GET only, no cookies, 15 s, 2 MB cap, at most 5 redirects. Private, loopback, link-local, CGNAT/Tailscale and `.local` addresses are refused, both before and after DNS and on every redirect, and the connection is pinned to the checked address. The page becomes readable text (`src/web/readable.ts`: main content, no scripts, menus or footers) stored as an ordinary text file, so the chip shows its tokens and cost before sending, and long pages are searched like big files. The same link within 24 hours reuses the stored text. | FK-06 |
| `project_files` | Project knowledge (PM-09): `project_id`, `file_id`, `deleted_at`. Built in M2 step 15 (`0017_project_files.sql`). Added in project settings (text, Markdown, Word, CSV, code; PDFs not yet), chunked and embedded once, and searched for every chat in the project together with any searched attachments: the question gets the 8 best excerpts, cited under the answer. The dialog shows each file's size, index status and what sending it whole would cost. Without an OpenAI key the files are kept but not used. | PM-09 |
| `message_files.mode` | `whole` / `retrieval` (column since M1, used from M2 step 14, FK-03). Text files over 20K tokens are searched by default, and the composer chip switches between Search and Whole. Over 200K tokens they're always searched, up to 5M. A searched file is chunked and embedded once (chunks keyed by file id, so reuse costs nothing), sent in history only as a one-line note, and the question being answered gets the 8 best-matching excerpts (about 3K tokens) as a text attachment. The answer stores them as `message_citations` with `kind = 'chunk'`, shown as "From your files: notes.txt, lines 120–140". PDFs up to 100 pages and 20 MB are sent as PDFs. Bigger ones (up to 200 MB), and every PDF added to project knowledge, are read on this machine with PDF.js (M4 step 7): their text is stored with a `--- page N ---` line before each page, searched by default, and their chunks carry `page`, so citations read "manual.pdf, page 12". | FK-02, FK-03 |
| `chunks`, `chunk_vectors` | Text pieces for retrieval: `source_kind` (`file`/`memory`/`message`), `source_id`, `ordinal`, `text`, `tokens`, `page`/`line_start`/`line_end` for citations; one vector per chunk per embedding `model`, L2-normalised float32 stored as base64 `TEXT` (SQL values cross into Rust as JSON). Built in M2 step 13 (`0016_vectors.sql`). Chunks are about 400 tokens on line boundaries with 2 lines of overlap (`src/knowledge/chunk.ts`). Embeddings come from the cheapest embedding model with a key: OpenAI `text-embedding-3-small` (Anthropic has none); every call is logged as `purpose: embed`. Search is a plain dot-product scan in TypeScript (`nearest`), so no native extension is needed: thousands of chunks take milliseconds. **This departs from the locked sqlite-vec decision; Isaac to confirm** (switch if the scan ever gets slow). | MM-11, FK-02 |
| `settings` keys for the app lock | `lock.passcode_hash` holds `pbkdf2-sha256$<iterations>$<salt>$<hash>` (WebCrypto PBKDF2-SHA-256, 600,000 iterations, 16-byte random salt), never the passcode. `lock.idle_minutes` (default 15, 0 = only at start) is how long the app can sit unused before locking. Built in M3 step 7 (SE-03). While locked, nothing of the app is rendered. After 5 wrong tries there's a wait, doubling from 30 s up to 5 min. A forgotten passcode can only be cleared by deleting everything (the database itself is already encrypted with the keychain key). | SE-03 |
| `settings` keys for prices | `catalog.fetched` holds a newer `data/models.json` fetched from the repo (`https://raw.githubusercontent.com/isaacholt-hash/fuse/main/data/models.json`) once you accept its changes; it's used only while its `price_version` is newer than the shipped one, and only if every routing tier's models are still in it. `catalog.price_edits` holds your own prices, as JSON keyed `provider/id`, with the day you set them, applied on top (the price version gets `+edits-<date>`). M4 step 3. | MM-04 |
| `settings` keys for models | `catalog.custom_models` holds models you added by hand (JSON, in the catalog's shape, with your prices and the provider's pricing page as source); they join the catalog after the price list and before your price edits. `catalog.model_check` holds the last read of the providers' model lists (weekly, and on demand): chat models not in the catalog, and catalog models a provider no longer lists, with the tiers that use them and the newest model of the same family. M4 step 4. | MM-03, MM-08 |
| `settings` keys for routing | `routing.policy` holds your routing policy in the `data/routing.json` shape, saved from Settings → Routing policy after it's scored on the routing test set (RT-16); it's used while it parses and every tier's models are in the catalog, otherwise the shipped policy is. Empty means the shipped one. `routing.project_rules` holds rules per project (JSON keyed by project id), tried before the global rules for that project's chats. M4 step 5. | RT-03, RT-16 |
| `imports` | Chats imported from other apps (PL-08): `source` (`chatgpt`/`claude`), `external_id` (the other app's conversation id, unique per source), `thread_id`. Built in M3 step 8 (`0021_imports.sql`). An import first previews what's new and skips anything already imported. Messages keep their original dates and branches (the other app's current branch becomes the active leaf). Answers keep the model name the export gives, with no cost, and imported chats aren't sent for memory suggestions. ChatGPT: `conversations*.json` in the export zip; system, tool and hidden nodes are skipped, and their children attach to the nearest kept message. Attachments aren't imported, only noted as `[image]` and the like. Claude (M3 step 9): `conversations.json` messages are a list, with `parent_message_uuid` giving branches in newer exports. Attachments become `[Attached: name]` notes. `projects.json` projects are found or made by name: their instructions fill an empty project's, and their documents become project knowledge files, indexed the first time they're searched. | PL-08 |
| `thread_tags` | A chat's tags (CH-02): `thread_id`, `tag` (lowercase, no spaces, unique per chat). Built in M4 step 1 (`0022_thread_organise.sql`), which also adds `threads.pinned_at` (pinned chats sit at the top of the sidebar) and `threads.archived_at` (archived chats are hidden behind an "Archived" toggle). Tags filter the sidebar, and `#tag` in search narrows results to that tag. | CH-02 |
| `artifacts.allow_cdn` | AR-05's per-artifact switch (`0023_artifact_cdn.sql`, M4 step 6): 1 lets the artifact's preview load scripts, styles, images, fonts and fetches from cdnjs, jsDelivr and unpkg (the Rust `preview:` scheme serves that page with those hosts in its policy). 0, the default, means nothing leaves the preview. React artifacts compile in the app (Sucrase) and run against React bundled into the page, so they need no network. | AR-05 |
| `messages_fts` | Full-text search index over `messages.content` (FTS5, external content: the text stays in `messages`; triggers keep it in step on insert, edit and delete, including text saved while streaming). Carries `workspace_id` and `user_id` unindexed so results are scoped like every table; it's an index, so it has no `created_at`. Built in M2 step 4 (`0012_search.sql`). Search (Ctrl+Shift+F) matches every word as a prefix, plus chat titles, skips deleted messages and chats, and opens the chat on the branch that holds the hit. | CH-02 |
| `threads.active_leaf_id NULL` | The selected branch tip. Built in M2 step 3 (`0011_branches.sql`). The screen and the history sent to models are the path from the root to this message (`src/storage/tree.ts`); NULL or a deleted id means the newest leaf. Editing a question adds a sibling question (same parent, same files); regenerating adds a sibling answer; a ‹ n/m › picker switches between siblings and shows the newest path under the chosen one. A stronger re-run sits beside its original on the path and isn't counted as a branch. Thread cost counts every branch, since all were billed. | CH-04 |
| `threads.memory_injection` | Built in step 7 (below). | PM-04 |
| `tags`, `thread_tags` | Tags (many-to-many). | CH-02 |
| `thread_summaries` | Rolling summary: `thread_id`, `covers_up_to_message_id`, `content`, token count, cost. | PM-06 |
| `messages_fts` | FTS5 virtual table over `messages.content` + thread titles. | CH-02, PM-10 |
| `settings` | Key/value per user. Built in step 7 (`0006_memory.sql`, below); later keys: `theme`, defaults. Never keys. | CH-05, PL-10 |
| `prompts` | Prompt library: `name`, `body`, `variables_json`, `project_id NULL`. | CH-12 |

### Memory: M1 step 7 (`0006_memory.sql`); vectors in M2

| Table | Purpose | Req |
| --- | --- | --- |
| `memories` | Approved facts only: `text`, `category` (`preference`/`person`/`project`/`fact`), `scope` (`global`/`project`) with `project_id NULL`, `source_thread_id NULL`, `confidence` (0–100; 100 when typed by you), `superseded_by_id NULL` (an approved update keeps the old fact as history), `deleted_at`. In use = not deleted and not superseded. | PM-02, PM-07 |
| `memory_proposals` | What the housekeeping model suggested after a chat, waiting for review: `op` (`add`/`update`/`delete`), `memory_id NULL` (the fact to change), `text`, `category`, `project_id NULL`, `confidence`, `source_thread_id`, `status` (`pending`/`approved`/`rejected`). Rejected ones are shown to the model next time so they aren't suggested again. Secrets are filtered out before a row is written (PM-05), so no row ever holds one. Memories pasted in Settings → Import (M3 step 10) also land here: one fact per line, split on the device with no model call, `source_thread_id` NULL, and facts already saved or waiting skipped. | PM-03, PM-05, PM-08 |
| `message_memories` | Which memories were sent with which answer. | PM-04 |
| `settings` | Key/value per user. Used now for `memory.suggest` (`on`/`off`) and `memory.budget_tokens` (default 1,500). Never keys. | PM-03, PM-04 |
| `threads.memory_injection`, `threads.memory_checked_at` | Memory on/off per chat, and the `last_message_at` the last memory check covered (a chat is checked again only after new messages). | PM-03, PM-04 |
| `memory_vectors` | M2: sqlite-vec `vec0` virtual table: `memory_id`, `embedding`. The embedding model and dimension are recorded in `settings`, and changing them triggers a re-index (MM-11). | PM-04 |

**How memory v1 works.** Leaving a chat with new messages (or "Suggest memories now" in its menu) sends its transcript, capped to the newest ~24,000 characters, plus the saved facts to the housekeeping model: the cheapest Cheap-tier model (`data/routing.json`) with a saved key. The call is logged with `purpose: memory`. Before each send, in-use memories (global plus the chat's project) go into the system prompt after the instructions. If they all fit the token budget they all go, otherwise the ones sharing the most and rarest keywords with the question (`src/memory/inject.ts`).

### Files and knowledge: M1+

| Table | Purpose | Req |
| --- | --- | --- |
| `files` | `name`, `mime`, `size_bytes`, `sha256`, `storage_path` (app data dir, outside the DB: `files/<sha256>`), `width NULL`, `height NULL` (images, for per-provider token estimates; added in M1 step 2), `token_estimate`, `parse_status`, `parse_error NULL`, `project_id NULL` (no FK until `projects` exists), `thread_id NULL`, `deleted_at`. Built in M1 step 2 (`0002_files.sql`). | FK-01 |
| `message_files` | Attachments per message, in `ordinal` order, with `mode` (`whole`/`retrieval`). Built in M1 step 2. | FK-03, CH-06 |
| `file_chunks` | `file_id`, `ordinal`, `text`, `page NULL`, `line_start NULL`, `line_end NULL`, `token_count`. | FK-02 |
| `chunk_vectors` | sqlite-vec `vec0`: `chunk_id`, `embedding`. | FK-02 |
| `url_cache` | `url`, `fetched_at`, `content`, `token_estimate` (24 h TTL). | FK-06 |
| `message_citations` | `message_id`, `ordinal`, `kind` (`chunk`/`web`), `chunk_id NULL`, `url NULL`, `title NULL`. Built in M1 step 4 (`0003_web_search.sql`, web only so far), with `messages.web_search_calls`, `request_log.web_search_calls` and `threads.web_search` (the composer toggle; new chats start with it on since 2026-10-28, chats saved before keep their setting). | FK-02, FK-05 |
| `user_instructions` | One row per user: `about_you`, `how_to_answer` (global custom instructions), with `threads.instructions` for one thread. Built in M1 step 5 (`0004_instructions.sql`). Composed into the system prompt at send time, global first and thread last (`src/chat/instructions.ts`); project instructions slot in between in step 6. | CH-05 |

### Artifacts: M1+

| Table | Purpose | Req |
| --- | --- | --- |
| `artifacts` | `thread_id`, `key` (the model's id, unique per thread), `title`, `type` (`markdown`/`code`/`html`/`svg`/`mermaid`/`react`), `language` (code), `deleted_at`. Built in M2 step 18 (`0019_artifacts.sql`). Every chat's system prompt opens with the artifact guide (`ARTIFACT_GUIDE`, first so it caches), which tells the model to wrap long documents, code files, pages and diagrams in `<artifact id type title language>`. Finished blocks in an answer are saved after it completes; the same id again in the thread is a new version. The chat shows a card for each and the content opens in a side panel (it streams live there too). Purged with incognito chats. Live previews (M2 step 21, AR-05):
  - **HTML** is served by the Rust `preview:` scheme (`src-tauri/src/preview.rs`; last 20 pages, 5 MB cap) with a policy that allows inline scripts and styles but no network (`default-src 'none'`, `connect-src 'none'`). It's shown in an iframe sandboxed to `allow-scripts` only, an opaque origin with no access to the app.
  - **SVG** shows as an `<img>`, which never runs scripts.
  - **Mermaid** renders in strict mode (mermaid 12.1.0, loaded lazily) to an SVG image.
  - Not built yet: React previews, `project_id` (AR-06), and `allow_cdns_json` (AR-05's per-artifact CDN switch). | AR-01, AR-05, AR-06 |
| `artifact_versions` | `artifact_id`, `version` (1, 2, …), `content`, `source` (`model`/`user`/`restore`), `message_id NULL`. Built with `artifacts` (step 18); a version is only added when the content changed. Kept forever; diffs are computed, not stored (`src/artifacts/diff.ts`, a line LCS). M2 step 19: the panel picks any version, shows a diff against another, restores an old one as a new `restore` version, and saves your own edits as `user` versions. While the latest version isn't the model's, every request in the thread ends its system prompt with `<edited_artifacts>` holding the current content, so the model builds on your edit. M2 step 20 (AR-03): **Ask AI** in the panel takes the selected text, or the whole artifact when nothing is selected, plus an instruction, and sends them as an ordinary chat message. It's routed, streamed and costed like any message, and asks for the whole artifact back under the same id. The reply becomes the next `model` version, and the panel opens it as a diff against the version it changed. | AR-02, AR-03 |

### Out of P1 (not designed here)

Agents/tools/MCP/audit (P2), sync metadata (P2: sync will need a per-row `version` / `sync_state`, added then), auth sessions and billing (P3).

## Encryption at rest (M1 C2)

- **What's encrypted:** the database (`fuse.db`) is SQLCipher. `src-tauri/src/db.rs` owns the connection, and the frontend sends SQL through the `db_execute` and `db_select` commands. The SQL plugin was dropped because it can't pass a key to its connections.
- **The key:** 32 random bytes, used as a raw key (`PRAGMA key = "x'…'"`), kept in the OS keychain under the account `database-key`. The frontend never sees it, except as the recovery key (Settings → Recovery key: 8 groups of 8 hex characters).
- **Upgrading an unencrypted database (first launch):**
  1. The WAL is checkpointed.
  2. `sqlcipher_export` copies the database into an encrypted file.
  3. Row counts per table are compared.
  4. The encrypted copy is swapped in, and the unencrypted file and any unencrypted backups are deleted.
- **If the keychain has no key, or the wrong one:** the app shows a locked screen that takes the recovery key, and puts it back in the keychain.
- **Migrations:** the same sqlx migrations as before, so `_sqlx_migrations` carries over.
- **Not encrypted yet:** attachment bytes in `files/<sha256>` (follow-up).

## M0 migration plan (step 3)

`0001_init.sql` creates `workspaces`, `users`, `threads`, `messages` (including `parent_id`), `request_log`, `schema_meta`, plus indexes:

- `messages (thread_id, created_at)`
- `threads (workspace_id, last_message_at DESC)`
- `request_log (created_at DESC)`

It also seeds the default workspace and user with fixed UUIDs. Before each migration the app copies the database file to `backups/fuse-<timestamp>.db` (section 16, Data).
