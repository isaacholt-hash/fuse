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
| `messages.feedback` | `up` / `down` / null. | CH-07, RT-11 |
| `messages.escalated_from_id NULL` | The answer this one escalated from. | RT-04 |
| `request_log.tier`, `request_log.route_rule_id` | Same as above, per call. | RT-09 |
| `threads.pinned_tier NULL`, `threads.pinned_model NULL`, `threads.pinned_provider NULL` | Per-thread pins: a tier (`balanced`/`best`) or a model; all NULL = Auto. Built in M1 step 10; chats from before it start on Auto. Per-message and per-project pins are not built yet. | RT-01, RT-06 |
| `budgets` | `scope` (`global`/`project`), `project_id NULL`, `period` (`day`/`month`), `limit_micro_usd`, `hard_stop`, `temp_raise_until NULL`. | CO-03, MM-09 |
| `budget_events` | Alerts fired (50/80/100%, anomaly), so each one shows once. | CO-03, CO-07 |
| `golden_prompts` | Eval set: `prompt`, `expected_tier` (`balanced`/`best`), `intent`, `complexity`, `needs_context`, `notes`, `position`. Built in M1 step 9a (`0007_golden_prompts.sql`), imported from a JSON Lines file in Settings; an import replaces the set. `rating` is left out until something uses it. | RT-16 |

The routing policy, tiers, model catalog and prices are **data files** in `data/`, not tables. User edits to them are saved as override files, not rows.

**`data/routing.json`** (M1 step 9, `src/routing/policy.ts`): three tiers in order (Cheap, Balanced, Best), each a list of `provider/model-id` from `data/models.json`; within a tier the app picks the cheapest model for the request's input size, ties going to `provider_preference`, then the chat's provider. `housekeeping` maps titles, classification, memory and summaries to a tier. `quality_floor` is the lowest tier allowed to answer per intent and complexity (RT-17). `rules` are first-match-wins (intent, complexity, capabilities, context size → tier, with a `reason` shown on the answer); the last must match everything. Neither a rule nor a floor may name Cheap: the file is refused at startup.

**Auto routing** (M1 step 10, `src/routing/classify.ts`, `src/routing/route.ts`): before each send a local classifier reads the question (length, code, attachments, keywords) as an intent and complexity. The first matching rule picks a tier, never below the floor. The cheapest model in that tier with a key and the needed capabilities answers. If none qualifies, the next tier up is tried; routing never moves down. The Cheap-model fallback for unsure classifications (RT-02) is not built yet. Settings → Routing test set scores the classifier against the imported prompts.

### Projects, instructions, threads: M1+

| Table / column | Purpose | Req |
| --- | --- | --- |
| `projects` | `name`, `instructions`, `default_tier NULL`, `provider_preference NULL`, `quality_floor_json NULL`, `deleted_at`. Built in M1 step 6 (`0005_projects.sql`) with `name`, `instructions`, `default_provider`/`default_model` (both NULL = new chats start on Auto; set = new chats in the project are pinned to that model since step 10; a project default tier is not built yet) and `deleted_at`. Deleting a project keeps its chats (they move out to no project). | PM-01, RT-17 |
| `threads.project_id NULL` | FK → projects. Threads can move between projects. Built in M1 step 6. | PM-01 |
| `threads.instructions NULL` | Per-thread custom instructions. Global instructions live in `settings`. | CH-05 |
| `threads.pinned`, `threads.archived_at NULL`, `threads.incognito` | Incognito threads never touch memory and aren't listed. | CH-02, CH-15 |
| `threads.current_leaf_id NULL` | The selected branch tip. | CH-04 |
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
| `memory_proposals` | What the housekeeping model suggested after a chat, waiting for review: `op` (`add`/`update`/`delete`), `memory_id NULL` (the fact to change), `text`, `category`, `project_id NULL`, `confidence`, `source_thread_id`, `status` (`pending`/`approved`/`rejected`). Rejected ones are shown to the model next time so they aren't suggested again. Secrets are filtered out before a row is written (PM-05), so no row ever holds one. | PM-03, PM-05 |
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
| `message_citations` | `message_id`, `ordinal`, `kind` (`chunk`/`web`), `chunk_id NULL`, `url NULL`, `title NULL`. Built in M1 step 4 (`0003_web_search.sql`, web only so far), with `messages.web_search_calls`, `request_log.web_search_calls` and `threads.web_search` (the composer toggle). | FK-02, FK-05 |
| `user_instructions` | One row per user: `about_you`, `how_to_answer` (global custom instructions), with `threads.instructions` for one thread. Built in M1 step 5 (`0004_instructions.sql`). Composed into the system prompt at send time, global first and thread last (`src/chat/instructions.ts`); project instructions slot in between in step 6. | CH-05 |

### Artifacts: M1+

| Table | Purpose | Req |
| --- | --- | --- |
| `artifacts` | `type` (`markdown`/`code`/`html`/`react`/`svg`/`mermaid`/`table`/`image`), `title`, `language NULL`, `project_id NULL`, `thread_id NULL`, `source_message_id NULL`, `current_version_id`, `allow_cdns_json NULL`, `deleted_at`. | AR-01, AR-05, AR-06 |
| `artifact_versions` | `artifact_id`, `version` (1, 2, …), `content`, `author` (`model`/`user`), `message_id NULL`, `request_id NULL`. Kept forever; diffs are computed, not stored. | AR-02, AR-03 |

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
