# M0 — Thin slice

**Goal:** a desktop chat app Isaac can use daily with both OpenAI and Anthropic models, showing the cost of every answer. Use it for a week before M1.

**Out of scope for M0:** routing, tiers, prompt caching, memory, projects, artifacts, attachments, web search, voice, images. Don't build hooks for them yet beyond the data-model rules in CLAUDE.md.

## Steps (one PR each, in order)

- [x] **1. Scaffold.** Tauri 2 + React + TS (Vite), pnpm, strict tsconfig, ESLint + Prettier, Vitest, Tailwind + shadcn/ui. Scripts: `dev`, `lint`, `typecheck`, `test`, `tauri dev`, `tauri build`. Empty window titled "FUSE" opens on HULK.
- [x] **1a. Ship-a-step skill.** Project skill that runs checks → app screenshot (Xvfb) → secret scan → PR → merge as one routine; add `gh pr merge`, `gh api`, `xvfb-run` to `.claude/settings.json`.
- [x] **2. CI.** GitHub Actions: on every PR run lint/typecheck/test on Linux. On manual trigger or `v*` tag, build Linux and **Windows** installers with `tauri-apps/tauri-action` and upload them as artifacts. Isaac confirms the Windows installer runs.
- [x] **2a. Data-model doc.** `docs/data-model.md`: all P1 tables designed (branches via `messages.parent_id`, projects, tier/rule fields, memory, artifacts); step 3 builds only the M0 tables, matching it.
- [x] **3. Storage.** SQLite via the Tauri SQL plugin; versioned migrations. Tables: `workspaces`, `users`, `threads`, `messages`, `request_log`. Seed one default workspace and user. Every table has `workspace_id`, `user_id`, `created_at`. Messages store role, content, provider, model, tokens (input, output, cached, reasoning), `cost_micro_usd`, `price_version`, `latency_ms`, status.
- [x] **4. Keys.** Rust commands to save / test / delete a key per provider in the OS keychain (`keyring` crate). Settings screen: paste key, "Test" makes a minimal call, shows masked key and status. Keys never cross into logs or the DB.
- [x] **4a. Provider API notes.** `docs/providers.md`: current streaming formats, token/cached/reasoning usage fields, pricing and model-list URLs, each linked and dated. Steps 5–7 build from it.
- [x] **5. Model catalog + cost.** `data/models.json`: provider, model id, display name, context window, max output, price per 1M tokens (input, output, cached input), capabilities, `verified_on`, `source_url`. **Fill from the providers' official pricing and models pages, and list what you used in the PR; if you can't reach them, leave a TODO and ask Isaac.** Pure `cost()` function with unit tests.
- [x] **5a. Fixture recorder.** `scripts/record-fixtures` that Isaac runs once with his shell keys; saves cleaned-up SSE recordings (text, usage, 429, error) for contract tests. No key ever reaches the repo.
- [x] **6. Adapter interface + Anthropic adapter.** `ProviderAdapter`: `listModels`, `streamChat(messages, model, options, signal)` yielding text deltas then a final usage record. Anthropic implementation with injected fetch; retry with backoff on 429/5xx (max 3). Contract tests against recorded SSE fixtures.
- [x] **7. OpenAI adapter.** Same interface and tests. Choose the OpenAI API (Responses or Chat Completions) from current OpenAI docs and say why in the PR.
- [x] **7a. UI mockup.** Clickable HTML mockup of the chat screen (sidebar, composer, model picker, cost badge); Isaac approves before step 8.
- [x] **8. Chat UI.** Thread list (new, rename, delete), chat view with streaming, stop button, Markdown + code blocks with copy. Model picker in the composer; switching model mid-thread carries full history. Each answer shows a badge: model · tokens · cost. Thread header shows total cost. Auto-title not required yet.
- [x] **9. Request log + debug panel.** Every call writes `request_log`; a simple debug view lists the last 100 requests with model, tokens, cost, latency, error.
- [x] **10. Polish for daily use.** Reopen on last thread, light/dark/system theme, `Ctrl+N` new chat, `Ctrl+K` model picker, clear error messages with retry.

## Carried to M1 (decided 2026-10-26)

- Database encryption with SQLCipher (PL-03)
- Auto-update + signed builds (PL-06)
- Golden prompt set, 50 real prompts with the expected tier (RT-16)
- Default tier mapping from current provider model lists and prices
- Design system (P2, when the web version and other users arrive): accent colour, spacing and type rules on top of the shadcn tokens (Isaac, 2026-10-27: the black-and-white mockup is good enough for now)

## Done when (Isaac checks)

- [x] Chat with at least one OpenAI and one Anthropic model; streaming and stop both work *(Isaac, 2026-10-27)*
- [x] Switch model mid-thread and the new model sees the whole conversation *(Isaac, 2026-10-27)*
- [x] Every answer shows model, tokens and cost within 1 s; a hand calculation for one message matches *(Isaac, 2026-10-27)*
- [x] Close and reopen: threads and costs are still there *(Isaac, 2026-10-27)*
- [x] Key secrecy: no key in the DB file, logs, or git history *(HULK, 2026-10-27: DB, backups, app logs and full git history scanned; the only hits are the fake `sk-proj…` test string from step 4's mask test)*
- [x] Windows installer from CI installs and works on the Windows PC *(Isaac, 2026-10-27)*
- [ ] Used it for real work for one week *(skipped: Isaac moved on to M1 on 2026-10-27 because the app isn't useful enough yet without attachments, search, memory and routing)*
