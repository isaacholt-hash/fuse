# AGENTS.md

Instructions for coding agents other than Claude Code (e.g. OpenAI Codex).

**`CLAUDE.md` is the source of truth for this repo. Read it first and follow it exactly.** It applies to every agent, not just Claude. The rules that matter most:

- **Secrets:** never read, print, log, commit or ask for an API key. Don't read `.env*` or `~/.config/fuse/`. Don't run `printenv`/`env`. Never create a `.env` file.
- **Scope:** do only the task you were given. For UI design work, follow `docs/ui-brief.md`, including its hard constraints.
- **Stack:** pnpm only. TypeScript strict, no `any` without a comment saying why. Tailwind v4 + shadcn/ui (add components with `pnpm dlx shadcn@latest add`). No new dependencies unless the task says so.
- **Git:** work on a branch (e.g. `m0/ui-mockup`), never on `main`. Never force-push.
- **Before you finish:** `pnpm lint`, `pnpm typecheck` and `pnpm test` must pass, and `git grep -nE "sk-[A-Za-z0-9_-]{20,}|sk-ant-"` must return only the line in CLAUDE.md that quotes this pattern.
