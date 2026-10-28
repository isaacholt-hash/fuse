# FUSE

**F**rontier models, **U**nified, **S**pend-**E**fficient. Owner: Isaac. Codename was JARVIS.

One desktop app (web in P2) that replaces the Claude and ChatGPT apps, runs on **Isaac's own API keys**, and **routes each request to the tier the task needs, then the cheapest model in that tier**. Built for one user first; data model ready for a product later.

- Full requirements: `docs/requirements.md` (requirement IDs like RT-04 refer to it)
- **Current milestone: `docs/milestones/M4-rest-of-p1.md`** — work only on what it lists (M0–M3 are built; Isaac skipped their trial weeks and M2/M3 testing on 2026-10-27/28)

## The 5 things that matter

1. **Routing is the product** — classifier picks a tier, one-click override, every answer shows cost and why.
2. **BYOK, local-first** — OpenAI + Anthropic at launch, one adapter interface for the rest. Keys and history stay on device.
3. **Memory and projects belong to the app** — switch models mid-thread, lose nothing.
4. **Cost visible everywhere** — per message / thread / project / month.
5. **Build for one, design for many** — every record has `workspace_id` + `user_id`; auth and billing are off.

## Decisions (locked 2026-10-26)

| Decision | Answer |
| --- | --- |
| Stack | Tauri 2 + React + TypeScript (Vite); SQLite locally (sqlite-vec added in P1 for memory) |
| UI | shadcn/ui + Tailwind |
| Package manager | pnpm |
| Platforms | **Desktop only in P1.** Dev on HULK (Linux). Windows builds come from GitHub Actions, not cross-compiling. Self-hosted web on HULK in P2 |
| Providers | OpenAI + Anthropic together from M0, held to streaming chat + token counts + cost |
| Web search | Provider-native search tools; no separate search key in P1 |
| Routing rule | Quality floor first (RT-17), cost second. Cheap tier never answers the user |
| Budget | No app budget in month one; provider-console hard limits + anomaly alert (CO-07) |
| Sync storage | Deferred to P2 |
| Build mode | **Claude builds and merges once checks pass; Isaac reviews after.** Small runnable steps, one PR each |
| Open | Default tier mapping — set from current provider model lists and prices in M1, never from memory |

## How to work in this repo

- **One step at a time.** Do the next unchecked step in the current milestone, nothing more.
- **Each step = one branch + one PR** (`m0/<short-name>`). PR description says: what changed, how Isaac tests it (exact commands), what's next.
- Before opening a PR: `pnpm lint`, `pnpm typecheck`, `pnpm test` pass, and the app starts with `pnpm tauri dev`.
- **Ship every step with the `ship-step` skill** (`.claude/skills/ship-step/`): `pnpm check`, `scripts/screenshot.sh`, PR, merge.
- **Merge it yourself once checks pass:** the checks above, a screenshot of the running app (HULK is headless: use Xvfb), the secret scan, and CI green once CI exists. Use `gh pr merge <n> --merge --delete-branch`. Don't merge if anything fails, or if the PR asks Isaac a question that's still open.
- After merging, **stop**: send Isaac the PR link, the screenshot and what's next. Start the next step only when he says so. If he asks for changes after a merge, they go in a follow-up PR.
- If something in the milestone looks wrong or a decision is missing, **ask Isaac** rather than guessing. Write questions as a short list with your recommendation for each.
- Isaac reviews in short sprints: keep PRs small, explanations short, and lead with what he needs to do.
- Tick the step's box in the milestone file in the same PR.

## Secrets — hard rules

- **Never read, print, log, commit or ask for an API key.** Not in code, tests, fixtures, logs, PR text or chat.
- In the app, keys live only in the OS keychain (Linux Secret Service / Windows Credential Manager) via Rust. Keys are entered by Isaac in the app's settings screen.
- Tests use **recorded fixtures** with no real keys. Live smoke tests are run by Isaac, reading keys from his own shell environment (`FUSE_OPENAI_API_KEY`, `FUSE_ANTHROPIC_API_KEY`); never create a `.env` file in the repo.
- Never query a password manager, database or any other store for keys.
- Before every PR: `git grep -nE "sk-[A-Za-z0-9_-]{20,}|sk-ant-"` must return nothing.

## Architecture rules

- TypeScript strict end to end. No `any` without a comment saying why.
- Provider code lives only in `src/providers/<name>/`. Chat, storage, cost and (later) routing never import a provider SDK.
- Adapters take an injected `fetch` (Tauri HTTP plugin on desktop, Node fetch on the P2 server) so they're reusable and testable.
- Prices, model catalog, tiers and routing policy are **data files** in `data/`, never constants in code. Every price has a `verified_on` date and source URL.
- Every table has `workspace_id` and `user_id` from the first migration. Migrations are versioned; never edit a shipped migration.
- Every provider request writes a local log row: provider, model, tokens (in/out/cached/reasoning), cost, latency, error.
- Money is stored as integer micro-dollars, never floats.
