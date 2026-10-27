# FUSE UI brief (step 7a mockup)

For a design model (GPT-6 Astra in Codex or ChatGPT) or a person building the **M0 chat UI mockup**. The output is a clickable mockup with fake data. Claude then wires it to real data in step 8.

## Goal

FUSE is a desktop chat app that replaces the ChatGPT and Claude apps. It runs on the user's own OpenAI and Anthropic API keys and shows **what every answer cost**. It's one user's daily tool: a technical power user who works in short bursts and wants speed, low friction and cost always visible. It should feel calm and dense, like a good developer tool, not like a marketing site.

Design principles:

1. **The conversation is the hero.** Chrome stays quiet, and text is very readable (long answers, code).
2. **Cost is always visible but never shouts.** Small, monospaced, muted numbers next to each answer and in the thread header.
3. **Keyboard first.** Every action has a visible shortcut hint, and focus states are clear.
4. **Model choice is one click away** and is always visible in the composer.

## Hard constraints (the output must drop into the repo as is)

- React 19 + TypeScript (strict, `noUncheckedIndexedAccess`), Vite. **No `any`.**
- Tailwind CSS v4 + **shadcn/ui** (style `radix-nova`, base colour neutral, CSS variables in `src/index.css`), `lucide-react` icons, Geist font. They're already installed.
- Add shadcn components only with `pnpm dlx shadcn@latest add <name>`, and don't hand-edit files in `src/components/ui/`. **No other new dependencies.** If you need one, write it in `docs/ui-mockup-notes.md` instead.
- Use theme tokens (`bg-background`, `text-muted-foreground`, `border`, etc.), never hard-coded colours. Both **light and dark** must look right (`.dark` class on `<html>`).
- Window minimum 640×480, typical 1100×750, and it must also work at 1600 wide.
- Put all mockup code under `src/mockup/` and fake data in `src/mockup/fixtures.ts`. Point `src/App.tsx` at the mockup. No network calls, no Tauri APIs, no storage.
- Components must be **presentational**: data comes in through typed props and events go out through callbacks (`onSend`, `onStop`, `onSelectModel`, …). That lets step 8 replace the fake data without restyling anything.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` must pass.
- Never put anything that looks like an API key in the code or fixtures. Masked keys look like `sk-…3f9a`, ellipsis included.

## Screens and states

### 1. Main layout

- **Left sidebar** (about 260 px, collapsible with `Ctrl+B`):
  - "New chat" button (`Ctrl+N`).
  - Thread list grouped Today / Yesterday / Previous 7 days / Older. Each row shows the title and that thread's total cost.
  - Hovering a row shows rename and delete. Rename is inline; delete asks for confirmation.
  - Settings at the bottom.
  - Empty state: "No chats yet".
- **Main area**: thread header + messages + composer.

### 2. Thread header

- Thread title (click to rename).
- **Thread total cost** (e.g. `$0.0412`) and total tokens.
- Overflow menu (rename, delete).

### 3. Messages

- User messages: right-aligned or subtly tinted, plain text.
- Assistant messages: full width, Markdown rendered (headings, lists, tables, inline code, links). Code blocks have a language label and a **copy** button (copied state).
- Under each assistant message, the **cost badge**: `claude-sonnet-… · 1,240 in / 380 out · $0.0093`. Show cached tokens when they're above 0 (`· 800 cached`). It sits quietly in muted mono text, and hovering shows a breakdown (input, output, cached, reasoning tokens; cost per part; latency).
- When the model changes mid-thread, show a thin divider: "Switched to GPT-… · full history sent".
- States to show:
  - **streaming** (text appearing, cursor or pulse, no badge yet)
  - **stopped by user** (partial text + "Stopped" tag)
  - **error** (inline card with a plain-English message, e.g. "Anthropic rate limit, retrying in 4 s", "Invalid API key: open Settings", plus a **Retry** button)
  - **empty thread** (centred prompt, with the current model shown and "Ctrl+K to change model")

### 4. Composer (bottom)

- Multi-line textarea that auto-grows up to about 40% of the height. `Enter` sends, `Shift+Enter` adds a new line.
- **Model picker** button showing the provider icon or label and the model name (`Ctrl+K`). It opens a searchable list grouped by provider (OpenAI, Anthropic). Each item shows its display name, context window, and price per 1M tokens in and out.
- Send button. While streaming, it becomes a **Stop** button (`Esc`).
- A disabled state when no key is set for the selected provider: "Add an Anthropic key in Settings".

### 5. Settings → API keys

- One card per provider (OpenAI, Anthropic).
- **No key**: a password-type input, then "Save & test".
- **Key saved**: a masked key `sk-…3f9a`, status ("Working · tested 2 min ago", "Invalid key", "Testing…"), and buttons **Test**, **Replace**, **Delete** (Delete confirms).
- A line of copy: "Keys are stored in your OS keychain and never leave this device except to call the provider."
- Theme picker: Light / Dark / System.

### 6. Debug panel (step 9, lower priority)

A table of recent requests: time, provider, model, tokens in/out/cached/reasoning, cost, latency, status or error. Make it reachable from Settings.

## Fake data to include

- 8–12 threads across the date groups, with mixed costs ($0.0003 – $0.41).
- One long thread that has a table, a 30-line TypeScript code block, a model switch (Anthropic → OpenAI), cached tokens on one answer and reasoning tokens on another.
- One thread showing each state: streaming, stopped, error.
- Models: two or three per provider. Make up plausible display names and prices, and label them fake in `fixtures.ts` (`// FAKE: placeholder, real catalog comes from data/models.json`).

## Out of scope (don't design these)

Routing/tier UI, projects, memory, attachments, artifacts panel, web search, voice, images, onboarding, login.

## Deliverables

1. `src/mockup/**`, with `src/App.tsx` rendering the mockup, plus a simple way to switch between states (e.g. a small dev-only state switcher in a corner).
2. `docs/ui-mockup-notes.md`: design decisions, anything you'd change in this brief, any dependency you wanted but didn't add.
3. Screenshots of main layout (light), main layout (dark), composer with the model picker open, and Settings → API keys.
