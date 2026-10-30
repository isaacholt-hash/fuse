# Functional Requirements — Unified AI Workspace (BYOM)

Oct 25, 2026 · @Isaac

## 1. Summary

One app, desktop and web, that replaces the Claude, ChatGPT, Claude Code and Codex apps with your own API keys and matches each request to the model tier its task needs, and only then picks the cheaper option among models that clear that bar. It is built for you first, with the data model and hooks needed to sell it later.

**The 5 things that matter most**

1. **Routing is the product.** A cheap classifier picks a model tier per request; you can override in one click, and every answer shows what it cost and why that model was chosen.
2. **Bring your own keys, local-first.** OpenAI and Anthropic at launch, other providers through one adapter interface. Keys and history stay on your device.
3. **Memory and projects belong to the app, not the model.** Switch models mid-thread and nothing is lost.
4. **Cost is visible everywhere.** Per message, per thread, per project, with budgets and a savings report against "always use the best model."
5. **Build for one, design for many.** Single-user v1; every record carries a workspace id and auth/billing are hooks that stay off.

**Decisions from the interview**

| Question | Your answer | What it means for the requirements |
| --- | --- | --- |
| Who is it for? | Me first, product later | Single-user v1 with no sign-up or billing; multi-tenant-ready data model from day 1 (section 15) |
| What does "optimize credits" mean? | My own API keys, cut my spend | Cost = token spend on your keys; the router picks the tier the task needs first and the cheapest model that clears it second; it never starts cheap and works up (sections 6 and 13) |
| V1 scope? | Everything incl. voice and images | Written in full, but phased: P1 chat + memory + artifacts + routing, P2 agents and tools, P3 voice and images (section 3) |
| Relation to your existing assistant? | Separate app | Requirements written from scratch; no dependency on existing code |
| Platforms | Desktop and web (from your brief) | Single codebase, feature parity except OS-only features; mobile apps later (PL-14, P3) |
| Coding tools too? (asked 2026-10-30) | Yes: Claude Code and Codex, not only the chat apps | A coding agent that works in a local repository (section 11b), built next in P1.5; picks from the feature inventory of all four products |

**How to read the requirements.** Each requirement has an ID (e.g. RT-04), a priority and a phase. **Must** = the phase cannot ship without it. **Should** = planned for the phase, can slip. **Nice** = do only if cheap. Phases P1, P2, P3 are defined in section 3.

## 2. Goals and non-goals

"Better than Claude and ChatGPT" means: the same daily workflow in one place, at lower cost, with nothing lost when you change models. The targets below are the acceptance test for v1.

| Goal | Target | How it is measured |
| --- | --- | --- |
| Lower cost | Monthly API spend at least 50% below the two subscriptions it replaces, at the same usage | Savings report (CO-04), 30-day comparison after launch |
| No feature regression | Your top 10 daily tasks work in the app without opening Claude, ChatGPT, Claude Code or Codex | Use-case checklist in section 4, run weekly during P1 |
| Model freedom | Switch model mid-thread with full context carried; add a new provider without code changes to chat or memory | CH-03, MM-01 adapter test |
| Cost transparency | Every answer shows model, tokens and cost within 1 second of completion | RT-09, CO-01 |
| Quality safety net | A weak answer can be escalated to a stronger model in one click, with context intact | RT-04 |
| Low friction | New chat from anywhere in under 1 second (global hotkey); app reopens where you left off | CH-09, CH-14 |

**Non-goals for v1**

- Hosting or fine-tuning models; the app only calls provider APIs and optional local models.
- Selling credits or holding other people's API keys on a server you run.
- Mobile apps in v1 (a responsive web layout is enough until PL-14 in P3).
- Team collaboration (shared projects, comments, roles); sharing a single chat or artifact by link is PL-13, P3.
- Matching every Claude or ChatGPT feature; the goal is your daily workflow, not parity.

## 3. Scope and phasing

**Recommendation: do not ship "everything" as v1.** Ship P1 (chat, projects, memory, artifacts, routing, cost) first, because routing plus cost plus memory is the reason to switch; voice and image generation are features people like but do not switch for, and each adds a large integration surface. Everything you asked for is still specified below, tagged by phase, so nothing is lost.

&#91;embedded content: roadmap · 3 phases, 2 gates\]

P1 is the whole product in miniature; P2 and P3 only add reach, and each waits for the gate before it.

Each phase ships only when its gate passes. P1's gate is the one that matters: if you are not using the app instead of Claude and ChatGPT for two straight weeks, fix P1 before adding anything.

**P1.5 (added 2026-10-29, re-ordered 2026-10-30) sits between P1 and P2 and is built while the P1 trial runs; anything the trial turns up is fixed first.** It has three parts, in this order:

1. **Continuity core** (from `docs/specs/fuse-requirements-v0.1.md`): FUSE owns your context in a provider-neutral form, so a project moves between models without losing decisions or constraints. Typed memory with scope, provenance and authority, decisions and tasks, one context assembler, an egress policy every send obeys, backup before migrations, and a documented export with restore (PM-12 to PM-19, SE-13 to SE-15, PL-11, PL-12). Gate: the two-provider continuity test (PM-19) passes, and no content reaches a blocked provider in tests.
2. **Coding agent** (added 2026-10-30, section 11b): what Claude Code and Codex do for your daily work. A project linked to a local repository; the agent reads, searches and edits files, runs commands with your approval, shows every change as a diff, works with git, reads CLAUDE.md and AGENTS.md, and does long runs with a plan and a cost cap, each step routed and priced like chat. It brings forward the parts of P2 agents it needs (AG-04, AG-05, AG-06). **Gate:** for two weeks you do your edit, run, review and commit loop in FUSE rather than in Claude Code or Codex, and no repo content reaches a blocked provider in tests.
3. **Local and lean:** cutting what each finished task costs, by answering what needs no model without one, doing housekeeping on a local model, sending less context, and reusing safe results (section 16b, from `docs/specs/local-ai-cost-optimization.md`). It is built while the P1 trial runs; anything the trial turns up is fixed first. **P1.5 gate:** measured cost per successful task is lower than the cloud-only baseline with no drop in quality on the routing test set, and local-only mode makes no cloud call. P2 follows P1.5.

## 4. Users and key use cases

V1 has one user: you, a technical power user who pays for two AI subscriptions, works in short sprints, and needs fast capture and an easy way to pick up where you left off. The future user is the same profile at scale: people already paying for two or more AI apps who want one place and a lower bill.

| Use case | Example | Typical tier (section 6) | Why it matters |
| --- | --- | --- | --- |
| Quick question | "What's the difference between X and Y?" | Balanced | Highest volume; savings come from not using Best here and from caching, not from a cheaper tier |
| Writing and editing | Draft an email, tighten a memo, rewrite in your voice | Balanced | Daily; needs your style instructions and memory |
| Long document work | Summarize a 60-page PDF, answer questions on it | Balanced, large context | Drives file handling and RAG requirements |
| Coding (chat) | Write or debug a snippet, explain an error | Balanced, escalate to Best | Code artifacts, run/copy |
| Coding (agent) | "Add a test for this and make it pass", fix a bug across files, commit and open a PR | Planner on Best, steps on Balanced | Replaces Claude Code and Codex: repo, commands, diffs, git (section 11b) |
| Analysis and data | Explore a CSV, build a chart, check numbers | Best + code execution (P2) | Needs sandbox and artifacts |
| Hard reasoning | Architecture decision, multi-step math, tricky tradeoff | Best, reasoning on | Where the strong model earns its price |
| Research | Find current info, compare sources, cite them | Balanced + web search | Needs search and fetch with citations |
| Image input | Screenshot of an error, photo of a form | Vision-capable tier | Common daily task |
| Agent task (P2) | "Check these 5 sites and log the results" | Planner on Best, steps on Balanced | Multi-step, tool-using, cost-capped |
| Voice (P3) | Dictate a thought while walking; have an answer read aloud | Cheap STT/TTS, LLM by content | Low-friction capture |
| Image generation (P3) | Product mockup, social graphic | Image model | Occasional; cost shown per image |

The top 10 daily tasks for the no-regression goal (section 2) are the first 9 rows above plus "continue yesterday's thread" and "find that thing we discussed last week."

## 5. Model management (bring your own model)

Providers plug in through one adapter interface; the router targets user-defined tiers, not model names, so a model swap never breaks a routing rule.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| MM-01 | Provider adapters for OpenAI and Anthropic at launch. One adapter interface (chat, streaming, tools, vision, embeddings, pricing) so Google, OpenRouter, Mistral and local models can be added without touching chat, memory or routing code. | Must | P1 |
| MM-02 | Enter one API key per provider; validate with a test call before saving; store in the OS keychain on desktop and encrypted at rest on web. Keys are never logged or sent anywhere but the provider. | Must | P1 |
| MM-03 | Model catalog per provider: auto-discover from the provider's model list where available, plus manual add. Fields: model id, display name, context window, max output, input/output/cached price per 1M tokens, capabilities (vision, tools, JSON mode, reasoning, streaming, audio), rate limits. | Must | P1 |
| MM-04 | Price list is data, not code: editable in the UI, date-stamped, and the app prompts to refresh when a price is older than 30 days. Default prices ship with the app and can be updated without a release. | Must | P1 |
| MM-05 | Tiers: user-defined named tiers (default set: Balanced, Best, Reasoning, Vision, Embedding, plus Cheap, which is reserved for housekeeping tasks such as titles, classification, memory extraction and summaries) each mapped to one model per provider in preference order. Routing rules reference tiers only. | Must | P1 |
| MM-06 | Health and failover: detect 429, 5xx, timeouts and outages per provider; auto-fail over to the same tier on the next provider; show provider status in the composer; retry with backoff. | Must | P1 |
| MM-07 | Per-model defaults: temperature, max output tokens, reasoning effort or thinking budget, system prompt prefix. Editable per tier and per project. | Should | P1 |
| MM-08 | Deprecation handling: flag a mapped model when the provider marks it deprecated or it disappears from the list; suggest the replacement. | Should | P1 |
| MM-09 | Spend caps per key: daily and monthly dollar limits with a hard stop and a one-click temporary raise. | Should | P1 |
| MM-10 | Local models (Ollama, LM Studio, llama.cpp server) as a provider, used for zero-cost tasks such as titles, classification and memory extraction when present. Superseded in part by LL-02 and LL-04 (embedded runtime, P1.5); an optional localhost adapter stays here. | Nice | P2 |
| MM-11 | Embedding model selection per provider, with a local option; changing it triggers a re-index prompt. | Should | P1 |
| MM-12 | Usage reconciliation: compare the app's token counts to the provider's usage endpoint or dashboard and show drift. | Nice | P2 |

## 6. Intelligent routing and cost optimization

The router picks the tier each task needs, not the cheapest one: intent, complexity and required capabilities set a floor, and cost only decides between models that clear it; you can override before or after any answer, and every choice is explained. Prompt caching and context summarization are part of routing because they move spend as much as model choice does.

&#91;embedded content: routing flow · 9 steps, 2 decisions, 1 escalation loop\]

A pinned request skips classification but still gets the context fit and the budget check; an escalation re-enters at prompt assembly one tier up, so nothing is re-classified.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| RT-01 | Three modes in the composer: Auto (default), pinned tier, pinned model. The current mode is always visible and changes in one click; a pin can be per message, per thread or per project. | Must | P1 |
| RT-02 | Task classification before each send: intent (chat, writing, coding, analysis, long document, reasoning, vision, creative), complexity (low, medium, high), required capabilities (tools, vision, JSON, large context). Local heuristics first (length, code fences, attachments, keywords), then a Cheap-tier model only when heuristics are unsure. Classification must cost under 2% of the request it routes. | Must | P1 |
| RT-03 | Routing policy is data: an editable rule set mapping (intent, complexity, capabilities, context size) to a tier, with provider preference. Defaults ship with the app; per-project overrides; import/export as a file. | Must | P1 |
| RT-04 | Escalation: a "try a stronger model" action on any answer re-runs the same context one tier up and shows both answers. Triggers: user click, thumbs-down, provider refusal, truncated output, or a cheap self-check that flags low confidence. | Must | P1 |
| RT-05 | Context fit: choose a model whose context window fits the request with headroom; when a thread outgrows the Balanced tier's window, summarize older turns (PM-06) before moving to a pricier long-context model. | Must | P1 |
| RT-06 | Tie-breaking across providers: lowest cost, then lowest measured latency, then user preference; a "stay on this provider for this thread" option. | Should | P1 |
| RT-07 | Prompt caching: place system prompts, project instructions, memory block and attached documents in the provider's cacheable prefix; order prompt parts for maximum cache reuse; show cache hit rate per thread and per month. | Must | P1 |
| RT-08 | Reasoning control: the router sets reasoning effort or thinking budget from complexity; the user can force maximum per message. Reasoning tokens are counted and priced separately. | Must | P1 |
| RT-09 | Transparency: every answer shows model, tier, the rule that fired, input/output/cached/reasoning tokens, cost, and "this would have cost $X on Best." | Must | P1 |
| RT-10 | Budget-aware routing: at 80% of a budget (CO-03) the default drops one tier and the user is told; at 100% every send asks for confirmation. | Must | P1 |
| RT-11 | Learn from overrides: when the user pins a stronger tier for the same intent three or more times, propose a rule change. The policy never changes silently. | Should | P1 |
| RT-12 | Compare mode: send one prompt to two or three tiers side by side on demand; the composer shows the combined cost before sending. | Should | P1 |
| RT-13 | Response cache: identical prompt and context within a configurable window returns the stored answer, opt-in per project. | Nice | P2 |
| RT-14 | Routing inside agent runs: planner on Best, steps on Balanced, summaries on Cheap, with a per-run cost cap (AG-07). | Should | P2 |
| RT-15 | Local-model fallback for low-stakes intents when a local model is configured (MM-10). Superseded in part by LL-04 (local stays inside the Cheap tier; answering with it needs RT-17 changed). | Nice | P2 |
| RT-16 | Evaluation set: a stored set of 50+ real prompts with the expected tier and a rating; a "test policy" action runs the classifier against it and reports accuracy before a policy change is saved. | Should | P1 |
| RT-17 | Quality floor: the policy sets a minimum tier per intent and complexity (defaults: every user-facing answer starts at Balanced; hard reasoning, architecture and multi-step analysis start on Best; Cheap is housekeeping only, meaning titles, classification, memory extraction and rolling summaries, and never answers the user). Cost ordering applies only among models at or above the floor; the budget downshift in RT-10 stops at the floor and asks instead of going lower. The floor is editable per project. | Must | P1 |

## 7. Conversations and chat experience

Chat must feel at least as fast and polished as the two apps it replaces, with two things they do not do: change model mid-thread and show cost on every answer.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| CH-01 | Streaming responses with stop; render Markdown, code blocks (copy, language label, line numbers), tables, LaTeX and Mermaid. | Must | P1 |
| CH-02 | Thread list with full-text search across all threads, pin, archive, tags, and grouping by project; search results open at the matching message. | Must | P1 |
| CH-03 | Switch tier or model at any message; full history is carried; each answer carries a model badge. | Must | P1 |
| CH-04 | Edit and resend any user message; regenerate any answer; both create a branch. A branch picker shows siblings and lets you compare them. | Must | P1 |
| CH-05 | Custom instructions at three levels: global (about you, how to answer), per project, per thread. The effective instruction set is viewable in one click. | Must | P1 |
| CH-06 | Attachments in the composer: drag and drop, paste (text and images), file picker; show size and estimated tokens before sending. | Must | P1 |
| CH-07 | Message actions: copy, thumbs up/down (feeds RT-04 and RT-11), try on another tier, open cost detail, quote into the composer. | Must | P1 |
| CH-08 | Keyboard-first: command palette, shortcuts for new chat, switch model, toggle search, focus composer; global hotkey on desktop opens a floating quick-capture composer. | Must | P1 |
| CH-09 | Auto-title after the first exchange using the Cheap tier (or a local model); rename inline. | Must | P1 |
| CH-10 | Resume state: the app reopens on the last thread with scroll position; answers that were interrupted are marked and can be continued. | Should | P1 |
| CH-11 | Export a thread as Markdown, PDF or JSON; copy as Markdown. | Should | P1 |
| CH-12 | Prompt library: saved prompts with variables, invoked by slash command or the palette; per project and global. | Should | P1 |
| CH-13 | Quote a selection of an answer and reply to it; the quote is sent as context. | Should | P1 |
| CH-14 | Tool calls and agent steps render as collapsible steps inside the answer, with inputs, outputs and cost per step. | Must | P2 |
| CH-15 | Incognito thread: no memory read or write, not saved to history, clearly marked. | Must | P1 |
| CH-16 | Share link for a thread (read-only, revocable) on web. | Nice | P3 |
| CH-17 | Side-by-side view of two answers (from branches or compare mode) with a diff for code and text. | Should | P1 |
| CH-18 | Custom assistants: a saved persona with instructions, files and tools, started like a chat; built on projects and the prompt library. | Nice | P2 |

## 8. Projects, memory and context

Memory lives in the app's database, is written as plain facts you can read and delete, and is injected into any model. This is what makes model switching free.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| PM-01 | Projects: a container holding instructions, knowledge files, a default tier or routing override, a default provider preference, memories scoped to the project, and threads. Threads can move between projects. | Must | P1 |
| PM-02 | Memory store: facts with text, source thread, date, scope (global or project) and a user-visible confidence; full list view with search, edit and delete; export and wipe. | Must | P1 |
| PM-03 | Memory extraction: at the end of a thread (or on demand) a Cheap-tier or local model proposes new facts, updates and deletions; you approve them, or set auto-approve per category (preferences, people, projects, facts about you). Nothing is written from an incognito thread. | Must | P1 |
| PM-04 | Memory injection: before each send, retrieve the most relevant memories by semantic and keyword search, capped at a configurable token budget (default 1,500), placed in the cacheable prefix (RT-07); a toggle disables injection per thread; the injected set is viewable per message. Extended by PM-18 (one context assembler) and to decisions and artifacts (search by meaning, P2). | Must | P1 |
| PM-05 | Secrets filter: memory extraction never stores API keys, passwords, card or account numbers, or government IDs; detected items are shown and skipped. | Must | P1 |
| PM-06 | Context management: when a thread nears the model's window, older turns are replaced by a rolling summary kept per thread; pinned messages and attachments are never summarized away; a context meter in the composer shows tokens used and the summarization point. | Must | P1 |
| PM-07 | "What do you know about me" view: memories grouped by category with the thread each came from. | Must | P1 |
| PM-08 | Import memories and custom instructions from ChatGPT and Claude exports; duplicates merged on review. | Should | P1 |
| PM-09 | Project knowledge: files attached to a project are indexed once and available to every thread in it (FK-02); the project shows index status and token cost of including each file whole. | Must | P1 |
| PM-10 | Cross-thread recall: "what did we decide about X last week" searches thread history and summaries, not just memories, and cites the thread. | Should | P1 |
| PM-11 | Memory conflict handling: a new fact that contradicts an old one shows both and asks which stands; the old one is kept as history, not silently overwritten. | Should | P1 |
| PM-12 | Typed memory records (provider-neutral, the system of record): fact, preference, person, constraint, decision, task and source reference. Provider message formats never become the stored form; adapters translate. | Must | P1.5 |
| PM-13 | Memory scope: global, workspace, project or conversation. Context selection respects scope. | Must | P1.5 |
| PM-14 | Memory provenance and status: authority (you, imported, extracted), source chat, message or artifact, extraction method and model, confidence, last verified, expiry, status (active, excluded, superseded, expired, deleted), sensitivity and whether it may be sent to providers. Raw history is kept apart from promoted memory. Each record carries `revision` and `device_id` so sync (PL-04) needs no second schema change. | Must | P1.5 |
| PM-15 | Decisions: a project's explicit choices with rationale, alternatives considered, status and what they replace. Never added automatically; always sent ahead of other memory. A model summary or extracted fact never overrides a decision or anything you entered (authority order: you > imported > extracted). | Must | P1.5 |
| PM-16 | Tasks: a project's open work with status and dependencies, listed in the project and available to context; open tasks are sent with decisions and constraints, never cut for budget (found by the PM-19 test). | Should | P1.5 |
| PM-17 | Exclude and explain: a memory can be excluded from future context without deleting it, and each answer records why each memory was used (keyword or meaning score and reason). | Must | P1.5 |
| PM-18 | Context assembler: one module builds a bounded package for every request, in this order: instructions, constraints and decisions, tasks, memories (ranked by authority, recency and relevance), summaries, file excerpts, history. Each part carries its source; the egress policy (SE-13) is applied before anything is sent. Merges LL-05. | Must | P1.5 |
| PM-19 | Two-provider continuity test: a recorded project history whose decisions and constraints must all reach both providers' requests (automated, no API calls), plus a live benchmark run with your keys. Gate: critical decisions and constraints kept in at least 90% of benchmark scenarios. | Must | P1.5 |

## 9. Files, knowledge and web search

Small files go into the prompt whole; large ones are indexed and retrieved with citations. The app picks, shows the cost difference, and lets you override.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FK-01 | Upload PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, source code and images (PNG, JPG, WebP, GIF) to a thread or a project; configurable size limit (default 50 MB); progress and parse errors shown. | Must | P1 |
| FK-02 | Parse, chunk and embed uploaded text locally; store chunks and vectors in the local database; retrieval returns chunks with file name and page or line; answers cite them. | Must | P1 |
| FK-03 | Whole-file versus retrieval: files under a token threshold (default 20k) go into the prompt whole; larger files use retrieval; the composer shows the token and cost difference and allows a per-file override. | Must | P1 |
| FK-04 | Image understanding: images route to a vision-capable tier; the router never sends an image to a text-only model. | Must | P1 |
| FK-05 | Web search: the model provider's native search tool in P1 (decided 2026-10-26); a pluggable own-key provider (Brave, Tavily, Exa or similar) later; toggle per thread and per message; results cited with title and URL; search cost counted. | Must | P1 |
| FK-06 | Fetch a URL into readable text (reader mode, no scripts), cached for 24 hours, with a size cap and a cost estimate before injection. | Must | P1 |
| FK-07 | Project knowledge sync: on desktop, watch a local folder and re-index changed files; on web, re-upload replaces and re-indexes. | Should | P2 |
| FK-08 | Spreadsheet and CSV analysis through code execution (AG-03), with the resulting chart or table shown as an artifact. | Should | P2 |
| FK-09 | OCR for scanned PDFs and images with text, using a local engine or a vision model, chosen by cost. | Nice | P2 |
| FK-10 | File viewer: open any attached file in the side panel with the cited page or chunk highlighted. | Should | P1 |
| FK-11 | Secrets warning: before a file is sent to a provider, scan for API keys, passwords and card numbers and ask to redact or continue. | Should | P1 |
| FK-12 | Deep research: a long, cited report built from many sources over several minutes, with a cost estimate first and a cap. | Should | P2 |

## 10. Artifacts and canvas

Anything the model produces that you will keep, edit or run opens in a side panel with versions, instead of scrolling by in the chat.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| AR-01 | Artifact types: Markdown document, code file (any language), HTML/React/SVG with live preview, Mermaid diagram, data table (CSV/JSON), image. The model is instructed to emit artifacts for long or structured output; the user can also promote any answer to an artifact. | Must | P1 |
| AR-02 | Versioning: every model or user edit creates a version; version list with timestamps; diff between any two; restore. | Must | P1 |
| AR-03 | Inline editing with "ask AI to edit the selection"; the edit request routes like any message and shows its cost; the result is applied as a new version with the diff highlighted. | Must | P1 |
| AR-04 | Export: download, copy, save to a chosen folder on desktop; Markdown exports to .md, .docx and .pdf. | Must | P1 |
| AR-05 | Sandboxed preview: HTML and React render in an isolated frame with no network by default; a per-artifact switch allows listed CDNs. | Must | P1 |
| AR-06 | Artifacts belong to a project, are searchable, and can be attached to any thread as context. | Should | P1 |
| AR-07 | Long-form writing mode: a document canvas with sections, per-section "rewrite, shorten, expand" actions, and comments the model can address. | Should | P2 |
| AR-08 | Run code artifacts in the sandbox (AG-03) with output shown beside the code. | Should | P2 |
| AR-09 | Publish an artifact as a read-only link (web). | Nice | P3 |

## 11. Agents, tools and connectors (P2)

Tools are opt-in per project, side effects need approval, and every run has a cost cap. MCP is the extension point so you never write a connector twice.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| AG-01 | Tool framework: built-in tools (web search, fetch URL, read and write project files, run code, read and write memory, create artifact) exposed through the provider adapters' tool-calling interface; each tool can be enabled per project; tool-requiring requests route only to tool-capable models. | Must | P2 |
| AG-02 | MCP client: add servers over stdio (local) and HTTP (remote) with OAuth; list and enable tools per project; show tool calls and results in the thread (CH-14); server health in settings. | Must | P2 |
| AG-03 | Code execution sandbox: Python and Node with common data libraries, files in and out, charts returned as images; desktop runs a local container or WASM runtime, web uses a hosted sandbox you control; no network by default; per-run time and memory limits. | Must | P2 |
| AG-04 | Approvals: read-only tools run freely; tools that write, send, delete or spend ask first, with "always allow for this project" per tool; an audit log records every tool call with inputs, outputs, model and cost. | Must | P2 |
| AG-05 | Agent runs: a request can start a multi-step run with a visible plan, step list, live progress, pause and stop, and a cost cap per run (default $1) that pauses the run for approval when reached. | Must | P2 |
| AG-06 | Routing inside runs (RT-14): planning and final synthesis on Best, routine steps on Balanced, summaries and classification on Cheap. | Should | P2 |
| AG-07 | Scheduled tasks: run a saved prompt with chosen tools on a schedule or once at a time; results land in a thread and a notification; failures are reported with the last step. | Should | P2 |
| AG-08 | Browser automation through a browser extension or an embedded browser, limited to sites the user allows; computer use on desktop, opt-in, screenshots shown before each action. | Nice | P3 |
| AG-09 | Parallel steps and sub-runs with a combined cost cap. | Nice | P3 |
| AG-10 | Prompt-injection guard: content fetched by tools is treated as data; instructions found inside it are shown to the user and never executed without confirmation. | Must | P2 |
| AG-11 | Built-in connectors (Drive, Gmail, Calendar, GitHub and similar) through MCP (AG-02), set up from settings. | Should | P2 |

## 11b. Coding agent (P1.5)

Added 2026-10-30. The first requirements missed that Claude Code and Codex are part of the daily workflow FUSE replaces; these come from the feature inventory of all four products, with Isaac's picks (Must = this phase, the rest later). Writes and commands ask first by default, every run has a cost cap, and repository content is project content for the egress policy (SE-13).

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| CA-01 | Repo-linked project: a project links to one local folder, usually a git repository. The agent lists, reads and searches files under it. The Rust side refuses any path outside the root, and skips ignored files and secret-looking files (`.env`, key files) unless you allow them. | Must | P1.5 |
| CA-02 | File edits: create, edit, move and delete files under the root. Every change is shown as a diff you can accept, reject or undo, per file or per run. | Must | P1.5 |
| CA-03 | Commands: run shell commands in the repository with output streamed into the run, a time limit, an output cap and the exit code shown. Starts on the host; sandboxing is CA-11. | Must | P1.5 |
| CA-04 | Permission modes per project: Ask (every edit and command), Auto-edit (edits run, commands ask), Plan only (read-only, proposes a plan). Commands can be always-allowed per project; destructive ones (force push, hard reset, recursive delete) always ask. Builds the coding part of AG-04, with the audit log. | Must | P1.5 |
| CA-05 | Git: status, diff, branch, commit with a message, push and open a pull request; a push always asks. A run can work on its own branch or worktree. | Must | P1.5 |
| CA-06 | Instruction files: CLAUDE.md and AGENTS.md (root and nested) go into the context assembler (PM-18) as instructions, each with its file as the source, and show in the effective-instructions view. | Must | P1.5 |
| CA-07 | Coding runs: a request starts a run with a plan, steps, live progress, pause and stop, and a cost cap that pauses for approval. Planning on Best, steps on Balanced, summaries on Cheap (RT-14), cost shown per step. Builds AG-05 and AG-06 for coding. | Must | P1.5 |
| CA-08 | Context budget for tools: file reads and command output are capped with a pointer to the rest, older tool results are summarized, and a run can be resumed from its record. Never whole repositories or logs (LL-05). | Must | P1.5 |
| CA-09 | Same rules as chat: every model call in a run goes through routing, the egress check in Rust and `request_log`. A Local only project runs no cloud step. | Must | P1.5 |
| CA-10 | Code review: review a diff, branch or pull request and report findings by severity. | Should | P2 |
| CA-11 | Sandboxed commands: an OS sandbox for commands, no network unless allowed. | Should | P2 |
| CA-12 | Skills: packaged instructions with files and scripts, called by name; extends the prompt library (CH-12). | Should | P2 |
| CA-13 | Hooks: your own commands at points in a run (before a tool, after a stop). | Nice | P2 |
| CA-14 | Subagents and parallel runs, each in its own worktree, with a combined cost cap (AG-09). | Should | P2 |
| CA-15 | Background runs on the HULK server (P2 web), handed over from the desktop, that keep going with the laptop closed. | Should | P2 |
| CA-16 | Remote control: follow and steer a run from another device through the web app. | Nice | P2 |
| CA-17 | Plugins: packs of skills, hooks and MCP servers. | Nice | P3 |
| CA-18 | Entry points outside the app: a `fuse` terminal command and an IDE extension. | Nice | P3 |
| CA-19 | Security scanning on a schedule (AG-07), with proposed fixes. | Nice | P3 |

## 12. Voice and images (P3, dictation earlier)

Dictation is cheap and fits the quick-capture goal, so it moves up to P2. Real-time voice conversation and image generation wait for P3 because each is its own integration and neither drives the switch.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| VI-01 | Dictation: push-to-talk in the composer and in the quick-capture window; speech-to-text through a provider API or a local engine; the transcript is editable before sending; cost per minute shown. | Should | P2 |
| VI-02 | Read aloud: any answer can be played with a chosen voice; text-to-speech through a provider API or a local engine; cached per message. | Should | P3 |
| VI-03 | Voice conversation mode: hands-free back-and-forth with interruption, using a real-time speech API where the provider offers one, otherwise a speech-to-text, model, text-to-speech pipeline; the transcript is saved as a normal thread and routed like text. | Nice | P3 |
| VI-04 | Image generation: provider abstraction for image models (OpenAI image models first); prompt, size, quality and count; images saved to the project and shown as artifacts; cost per image shown before generating. | Should | P3 |
| VI-05 | Image editing: edit with a mask or a reference image where the provider supports it. | Nice | P3 |
| VI-06 | Image input is covered by FK-04 in P1. | Must | P1 |

## 13. Cost visibility and budgets

Every token is priced the moment it is counted, so cost appears at the message, thread, project and month level without a batch job. The savings report is the proof that the app pays for itself.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| CO-01 | Per-message cost from the provider's returned token counts (input, output, cached, reasoning) times the catalog price at send time; stored with the message; rolled up per thread and shown in the thread header. | Must | P1 |
| CO-02 | Usage dashboard: spend by day, week and month; by provider, model, tier, project and intent; compared to the previous period. | Must | P1 |
| CO-03 | Budgets: monthly and daily, global and per project; alerts at 50, 80 and 100%; optional hard stop; one-click temporary raise. | Must | P1 |
| CO-04 | Savings report: for each month, actual spend versus (a) the same requests on the Best tier and (b) a subscription baseline you enter; shows cache savings and summarization savings separately. | Must | P1 |
| CO-05 | Cost preview before send when the request exceeds a token threshold (default 20k): shows estimated cost and offers to summarize, drop attachments or switch tier. | Must | P1 |
| CO-06 | Export usage as CSV; a reconciliation view against the provider's reported usage (MM-12). | Should | P2 |
| CO-07 | Anomaly alert when a day's spend exceeds three times the trailing 14-day average. | Should | P1 |
| CO-08 | Search and tool costs (web search calls, sandbox time, speech, images) are priced and included in all rollups. | Must | P1 for search, P2/P3 for the rest |

## 14. Platforms: desktop and web

One codebase serves both; the desktop app adds OS features (hotkey, local files, local models, keychain) and the web app is the same UI served from a server you control.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| PL-01 | Desktop builds for Windows and Linux (macOS dropped from P1, decided 2026-10-26); web supports the last two versions of Chrome, Edge, Safari and Firefox; responsive layout down to 390 px wide. | Must | P1 |
| PL-02 | Feature parity between desktop and web except OS-only features; those degrade visibly (greyed with a reason) rather than disappearing. | Must | P1 |
| PL-03 | Storage: desktop stores everything locally in an encrypted database (plain SQLite in M0; SQLCipher in M1, decided 2026-10-26); web v1 runs as a self-hosted single-user server with the same database, protected by a login. No shared cloud storage in P1. | Must | P1 |
| PL-04 | Sync across devices: end-to-end encrypted sync of threads, memory, projects and settings through a storage location you own (your server, S3-compatible bucket or a file-sync folder); conflicts resolved per record with last-writer-wins and a history. Syncs logical records and versioned files, never the database file; competing edits to decisions or facts go to review; device revocation, deletion propagation and lost-key behaviour defined; sync is not backup (PL-11). | Should | P2 |
| PL-05 | Offline on desktop: read history, draft and queue messages, use local models; queued sends go out when back online with a notice. | Should | P2 |
| PL-06 | Auto-update with signed builds and release notes; web deploys with a version shown in settings. Planned for M1; M0 installs by hand from CI artifacts. | Must | P1 |
| PL-07 | OS integration: menu bar or tray icon, global hotkey for quick capture (CH-08), system notifications for finished runs and budget alerts, "send selection to app" from any application. | Should | P1 |
| PL-08 | Import threads and projects from ChatGPT and Claude data exports, preserving dates and attachments. | Should | P1 |
| PL-09 | Deep links to a thread, artifact or project that work in desktop and web. | Nice | P2 |
| PL-10 | Theme: light, dark and system; font size setting; reduced motion. | Must | P1 |
| PL-11 | Backup and restore: an automatic encrypted backup before every database migration (the rollback path; migrations stay forward-only), backup and restore on demand, and an integrity check of stored files against the database. | Must | P1.5 |
| PL-12 | Portable export and restore: a documented, versioned format (`docs/export-format.md`; JSON plus files named by hash) another program could read, and restore of a project or everything, with duplicates removed and ids kept stable. Extends SE-07. | Must | P1.5 |
| PL-13 | Share a chat or artifact by link, served from your own server, read-only. | Nice | P3 |
| PL-14 | Mobile apps (iOS and Android) over the self-hosted server. | Nice | P3 |

## 15. Accounts, security and privacy

V1 is single-user and local-first; the product-ready pieces (multi-tenant data model, auth, usage ledger) are built in from the start and switched off, because retrofitting them is the expensive path.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| SE-01 | Local-first data: database, files, vectors and keys stay on the device (desktop) or on your self-hosted server (web); no prompt, response or file is sent anywhere except the chosen provider. | Must | P1 |
| SE-02 | Key handling: keys in the OS keychain or an encrypted store; shown masked; rotated in place; never written to logs, exports or crash reports. | Must | P1 |
| SE-03 | App lock: optional passcode or OS biometric on desktop; login on self-hosted web; sessions expire. | Must | P1 |
| SE-04 | Multi-tenant-ready model: every record carries workspace and user ids from day 1, with a single default workspace in v1; queries are scoped by workspace. | Must | P1 |
| SE-05 | Auth hooks for the product phase: email plus passkey or OAuth sign-in, sessions, MFA, workspace invites; implemented behind a feature flag and off in v1. | Should | P3 |
| SE-06 | Billing hooks for the product phase: the usage ledger (CO-01) is the source for a future credits or subscription model; a Stripe adapter and a "credits" wallet are designed, not built, in v1. | Nice | P3 |
| SE-07 | Data export of everything (threads, memories, projects, artifacts, usage) as JSON and Markdown, and delete-all with confirmation. | Must | P1 |
| SE-08 | Telemetry: off by default; opt-in anonymous crash and feature-usage reports with no prompt content. | Must | P1 |
| SE-09 | Provider data settings surfaced in the app: show each provider's data-retention and training policy for API traffic with a link, and the setting to opt out where one exists. | Should | P1 |
| SE-10 | Audit log of tool calls, key use and policy changes (AG-04), exportable. | Should | P2 |
| SE-11 | Secrets scanning on files and memory (FK-11, PM-05) and redaction of detected secrets in logs and exports. | Should | P1 |
| SE-12 | Dependency and build security: signed releases, pinned dependencies, automated vulnerability scanning in CI. | Should | P1 |
| SE-13 | Egress policy: per project and per record, which providers may receive content (allow or block), privacy mode (Normal, Local only, Cloud only) and whether content may go to a provider for embeddings. Every path that sends checks it, failover, compare, housekeeping, embeddings, retrieval and the classifier's second opinion included, in the Rust transport as well as the router. Blocked content is never sent; you see why. | Must | P1.5 |
| SE-14 | Threat model covering local compromise, sync compromise, malicious imports and provider exposure (`docs/threat-model.md`), reviewed when sync or tools land. | Should | P1.5 |
| SE-15 | Clear boundaries in Settings → Privacy: local storage doesn't mean local inference; cloud answers send the selected context to that provider. | Must | P1.5 |

## 16. Non-functional requirements

The app must never lose a message, must add almost no latency of its own on top of the provider, and must let you add a provider or a tool without touching the core.

| Area | Requirement | Target |
| --- | --- | --- |
| Performance | App overhead before the provider call (classification, memory retrieval, prompt assembly) | Under 300 ms at p95; first streamed token shown as soon as the provider sends it |
| Performance | Cold start to usable composer | Under 3 s on desktop, under 2 s on web after login |
| Performance | Full-text search across 10,000 threads | Under 300 ms |
| Reliability | No message loss: drafts, in-flight requests and partial responses persist across crash, close and network loss | Zero lost messages in testing; interrupted answers resume (CH-10) |
| Reliability | Provider errors | Retry with backoff up to 3 times, then fail over (MM-06), then a clear error with a retry button; never a silent failure |
| Observability | Local request log per message: model, tokens, latency, cost, cache hit, rule fired, errors | Viewable in a debug panel; exportable; retained 90 days by default |
| Extensibility | Provider adapters, tools, MCP servers and routing policy are plug-ins or data | A new provider in one module with no changes elsewhere; routing rules editable without a release |
| Testability | Router policy has a golden test set (RT-16) run in CI; adapters have contract tests against recorded provider responses | Policy accuracy reported on every change |
| Accessibility | Keyboard navigation for every action, screen-reader labels, visible focus, font scaling, reduced motion, color contrast | WCAG 2.1 AA |
| Data | Single local database (relational plus vector index) with versioned migrations and automatic backups before each migration | Restore from backup tested per release |
| Maintainability | One codebase for desktop and web, typed end to end, semantic versioning, release notes | Single repository, CI on every change |

## 16b. Local and lean (cost optimization)

Folded in on 2026-10-29 from `docs/specs/local-ai-cost-optimization.md` (v1.0, the source of record). That spec is additive: it reuses FUSE's router, request log, budgets and storage, and builds no second ones. **Success metric: cost per successful task**, not token counts or the share of requests answered locally. Its P0 items are phase P1.5 here, its P1 items map to existing ids or P1.5, and its P2 items are P2.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| LL-01 | Deterministic first: requests that allowlisted handlers can answer (arithmetic, unit, date and time conversion, counting, JSON or CSV checks) are answered without any model, shown as "answered without a model · $0", and logged as such. Handlers are permission-scoped, time-limited and audited; never model-generated shell commands. Off per project if you prefer. | Must | P1.5 |
| LL-02 | Embedded local inference: a local runtime behind the provider adapter interface (GGUF, quantized, bounded context, cancel, timeouts, unload and reload, limited concurrency), with no separate service to run. First tasks: classification, structured extraction, query rewriting and short summaries, where evaluation shows they're good enough. Never approves sensitive actions or lowers the tier of high-stakes work. | Must | P1.5 |
| LL-03 | Hardware detection and opt-in model install: RAM, CPU features and GPU where readable without privileges; disk size versus peak memory; compatibility, download size, version and licence shown before download; checksum verified; stored apart from the app and removable or updatable. FUSE works fully without it. | Must | P1.5 |
| LL-04 | Routing outcomes inside the existing router: `deterministic` before routing, and `local` as the preferred provider inside the Cheap tier, falling back once to the cloud Cheap model (no retry loops). Uses intent, complexity, risk, privacy mode, hardware, preferences, budget and recent model performance. Privacy modes per project: Normal, Local only (refuse cloud with a clear message), Cloud only. Manual override stays. | Must | P1.5 |
| LL-05 | Context minimization: lexical retrieval (SQLite FTS5) over files and knowledge first, with embeddings added when available, so search works without an OpenAI key; token ceilings per model and request type with explicit truncation and provenance; never whole histories, repositories, logs or tool outputs; retrieved content treated as untrusted. | Must | P1.5 |
| LL-06 | Exact-match response cache (merges RT-13): keyed by normalised input, context version, model or operation version, project scope and output format; TTLs and invalidation; never for personal, dynamic or high-stakes requests without a validity check, nor in incognito or for answers that used web search. Semantic caching stays off. | Should | P1.5 |
| LL-07 | Economics: cost per successful task (a message's attempts, retries, escalations and regenerates counted as one task; success when it isn't redone or marked bad), cloud calls avoided, context tokens avoided, local latency, fallback rate. API spend is kept apart from subscriptions and local energy. No prompt text in telemetry by default. | Must | P1.5 |
| LL-08 | Local-path security: model files treated as third-party dependencies (origin, checksum, licence, update provenance); out-of-memory and crash isolation; no network request from the local path; tests for offline use, local-only mode, cross-project isolation, malformed model output and resource exhaustion. | Must | P1.5 |
| LL-09 | Evaluation and rollout: a cloud-only baseline on the routing test set and on real usage (quality, cost per successful task, p50/p95 latency, peak memory); shadow mode, where the local decision is recorded beside the cloud one but not used; a false-downgrade rate; local on as soon as a model is installed (Isaac, 2026-10-30), with one-click rollback. | Must | P1.5 |
| LL-10 | Later, only if measurements justify it: semantic response cache, local answers to simple chat (needs RT-17 changed), more local model profiles, batch APIs, offline-only modes. | Nice | P2 |

**Where FUSE stands (traceability, 2026-10-29)**

| Spec | Status | Builds on |
| --- | --- | --- |
| FR-01 Deterministic first | Missing | — (every message goes to a model) |
| FR-02 Embedded local inference | Missing | `ProviderAdapter` (`src/providers/types.ts`); `ProviderId` is `openai`/`anthropic` only today |
| FR-03 Hardware and install | Missing | Prices and models as data (`data/`), keychain and app data storage |
| FR-04 Unified routing | Partly done | One router (`src/routing/route.ts`): tiers, quality floor (RT-17), escalation (RT-04), failover (MM-06), pins (RT-01), Cheap classifier fallback (RT-02), caps (MM-09), budgets (CO-03, RT-10). Missing: deterministic and local outcomes, privacy modes |
| FR-05 Context minimization | Mostly done | Rolling summaries (PM-06), searched large files with citations (FK-02, FK-03), memory budget, context meter, cost preview over 20K tokens (CO-05), FTS5 over messages (CH-02). Missing: lexical file retrieval, token ceilings |
| FR-06 Caching | Partly done | Provider prompt caching and hit rate (RT-07). Missing: response cache (RT-13, now LL-06) |
| FR-07 Economics | Mostly done | `request_log` per call (purpose, attempt, tokens incl. cached and reasoning, cost, latency, TTFT, errors, tier, rule), usage dashboard (CO-02), budgets, savings report (CO-04). Missing: cost per successful task, calls and tokens avoided |
| FR-08 Security | Partly done | SQLCipher and keychain, sandboxed previews (AR-05), secrets filters (PM-05, FK-11), project scoping, delete-all (SE-07). Missing: model provenance, runtime isolation, network-off tests |
| §7 Evaluation | Partly done | Routing test set and scoring (RT-16), policy changes scored before saving. Missing: baseline, shadow mode, false-downgrade rate, latency and memory figures |

**Conflicts with earlier decisions, and the proposed adaptation**

- **RT-17 (Cheap never answers you):** kept. Local runs inside the Cheap tier and does housekeeping only; answering chat locally is LL-10 and needs RT-17 changed on the record.
- **Routing contract** (`deterministic \| local \| balanced \| best` in the spec): FUSE keeps its tiers. `deterministic` is an outcome before routing and `local` a provider within Cheap, so there is still one router.
- **Lexical before vector:** FUSE already searches files with OpenAI embeddings (FK-02). Lexical FTS5 is added beside it, as the default and the fallback, rather than replacing it.
- **MM-10 (Ollama and similar as a provider):** the spec prefers an embedded runtime with no separate service, so LL-02 supersedes it for P1.5; an optional localhost adapter for Ollama or LM Studio users stays possible.
- **Providers:** `ProviderId` is widened to include `local` (CLAUDE.md: "one adapter interface for the rest").

## 17. Risks and open questions

The biggest risk is scope: a solo build of "everything" at a few hours a week does not ship. The second is routing trust: a few wrong-tier answers and you stop trusting Auto mode, which kills the savings.

| Risk | Why it matters | Mitigation in this spec |
| --- | --- | --- |
| Scope creep | P2 and P3 each double the integration surface | Phase gates (section 3); P1 is usable on its own |
| Routing quality | A wrong tier wastes money or gives a weak answer | Golden test set (RT-16), one-click escalation (RT-04), learn from overrides (RT-11), transparent reasons (RT-09) |
| Provider churn | Models, prices and features change monthly | Catalog and prices as data (MM-03, MM-04), tiers not model names (MM-05), deprecation flags (MM-08) |
| Holding keys on a server | If web is hosted for others, you hold their keys and liability | Web v1 is self-hosted single-user (PL-03); hosted multi-user is a P3 decision with its own security review |
| Prompt caching differences | Each provider caches differently; a wrong prompt order loses the savings | Adapter owns prompt ordering (RT-07); cache hit rate is visible |
| Local-first versus sync | Sync adds conflict handling and an encryption design | Local only in P1, encrypted sync in P2 (PL-04) |
| Agent cost runaway | A looping run can spend fast | Per-run cost cap (AG-05, CA-07), approvals (AG-04, CA-04), budget stops (RT-10) |
| Coding agent on the host | Commands run with your user's rights before sandboxing (CA-11) | Ask by default (CA-04), destructive commands always ask, paths checked in Rust (CA-01), no secret files read by default |
| Matching Claude Code and Codex | Both are mature and change weekly | Gate on your own edit-run-review-commit loop, not feature parity; the inventory is revisited each phase |
| Native local runtime | A C++ runtime adds build time, app size and crash risk on two OSes | Behind the adapter (LL-02), crash and memory isolation (LL-08), built in CI on Windows and Linux, opt-in |
| Model licence and provenance | A downloaded model is third-party code with its own licence | Pinned source, checksum and licence in `data/`, checked before download (LL-03, LL-08) |
| False downgrades | A small local model misjudges a hard request and the answer suffers | Local only for housekeeping (RT-17 kept), shadow mode and false-downgrade rate before enabling (LL-09), one fallback to the cloud |
| Rebuilding the memory table | Changing typed memory means rebuilding a table that holds your data | Backup before every migration comes first (PL-11); migration tested on a copy of a real database |
| Egress gaps | One missed send path leaks content to a blocked provider | One checkpoint in the Rust transport (SE-13) plus a test per path |
| Context changes | A new assembler changes answers and prompt-cache hits | Cache-friendly order kept (RT-07); routing test set and continuity test compared before and after |
| Hardware variance | What runs well on one PC stalls another | Hardware profile and compatibility card (LL-03); benchmarks on Isaac's own PC; cloud path always works |

**Decisions needed before build starts**

Answers live in the Decisions table in `CLAUDE.md` (locked 2026-10-26).

- [x] Tech stack: Tauri 2 + React + TypeScript, SQLite (sqlite-vec in P1)
- [x] Where web v1 runs: desktop only in P1; self-hosted web on HULK in P2
- [x] Web search: provider-native search tools in P1
- [ ] Default tier mapping: open, set in M1 from current model lists and prices. Budget for month one: decided (no app budget; provider-console hard limits + CO-07 alert)
- [ ] Storage location for P2 sync: deferred to P2

**Decided 2026-10-29 for Continuity core (from `docs/specs/fuse-requirements-v0.1.md`)**

- [x] Placement: Continuity core is P1.5 part 1 (M5), before Local and lean (M6); P2 follows
- [x] One requirement list: the spec's items are folded in as PM-12 to PM-19, SE-13 to SE-15, PL-11 and PL-12; its Phase 0 market validation and commercial gates are product-phase (P3) notes, not built now
- [x] Decisions and tasks are typed memory records with their own fields, not separate tables
- [x] Approval: extracted memories still need review; your own entries and confirmed imports are saved straight away; decisions are never added automatically
- [x] Scopes: global, workspace, project and conversation, added now
- [x] Embeddings: a per-project switch to never send content to a provider for search; keyword search (LL-05) covers those projects until local embeddings arrive
- [x] Rollback: an automatic encrypted backup before every migration, built first; no reverse migrations
- [x] Egress is checked in the Rust transport as well as the router

**Decided 2026-10-30 for P1.5 part 2 (Coding agent)** (all as recommended)

- [x] Where tools run: file and command tools in Rust, behind the same transport as provider calls, with the path check there
- [x] First version: one repository per project, desktop only, commands on the host with Ask as the default mode
- [x] Tool calling: through each provider adapter's native tool interface (both providers at once), not a text protocol
- [x] Git hosting: GitHub through the `gh` command already on the machine; no GitHub token stored by FUSE in this phase
- [x] Gate: two weeks of your edit, run, review and commit loop in FUSE (section 3)

**Open decisions for P1.5 part 3 (Local and lean), with the recommendation**

Decided 2026-10-30:

- [x] Local runtime: embedded llama.cpp through Rust (`llama-cpp-2`), in a worker process, CPU build first, GPU (Vulkan) later; no Ollama or LM Studio adapter in M7
- [x] Models: Qwen3 1.7B and Qwen3 4B, 4-bit GGUF, non-thinking mode, chosen by hardware; licence, source and checksum verified at implementation, downloaded only when you opt in
- [x] RT-17 kept: local does housekeeping only (titles, classification second opinion, memory suggestions, summaries, query rewriting)
- [x] Privacy modes per project: Normal, Local only, Cloud only (built in M5)
- [x] Local is on as soon as a model is installed, with one switch to turn it off; benchmarks and shadow results come from Isaac's PC but don't gate it (LL-09 changed)
- [x] The app's name: FUSE

## 18. Next steps

**Do now**

- [ ] Decide the six open items in section 17 (one sitting; none needs research beyond a stack choice)
- [ ] Write the P1 default routing policy and tier mapping as a file, with 50 real prompts from your history as the golden set (RT-16)
- [ ] Build the thin slice: one provider adapter, streaming chat, per-message cost. Use it for a week before adding anything

**Do next**

- [ ] Add the second provider, tiers, Auto routing and escalation; then memory, projects and artifacts
- [ ] Run the no-regression checklist (section 4) weekly; P1 ships when you have not opened Claude or ChatGPT for two weeks

- [x] P1.5 part 1, Continuity core (M5): built 2026-10-29 (`docs/milestones/M5-continuity-core.md`); live continuity benchmark passed 2026-10-30 (100% kept on claude-sonnet-5-5 and gpt-6.1-sol, gate 90%). Backup before migrations first (PL-11), then typed memory (PM-12 to PM-14), decisions and tasks (PM-15, PM-16), exclude and explain (PM-17), the context assembler (PM-18), the egress policy (SE-13), export and restore (PL-12), the continuity test (PM-19), privacy wording and threat model (SE-14, SE-15)
- [x] P1.5 part 2, Coding agent (M6, section 11b, added 2026-10-30): built 2026-10-30 (`docs/milestones/M6-coding-agent.md`); live benchmark passed 3 of 3 on both providers (2026-10-30); Isaac skipped the two-week gate (2026-10-30). Tool calling on both providers, a linked repository read through Rust, CLAUDE.md and AGENTS.md, runs with plan, steps, cost cap and summaries, edits with diffs and undo, commands with approval, permission modes and always-allow, git with branch, commit, push and PR, egress on every send path, and the coding benchmark (CA-01 to CA-09)
- [x] P1.5 part 3, Local and lean (M7, section 16b): built 2026-10-30 (`docs/milestones/M7-local-and-lean.md`). The automated P1.5 gate passes: cost per successful task fell 21% on the routing test set with no quality drop, and a Local only project makes no cloud call. Cost per successful task (LL-07), answers without a model (LL-01), Qwen3 1.7B or 4B built in through llama.cpp in a worker process, with hardware detection and a checked install (LL-02, LL-03), housekeeping local first (LL-04), search by word without a key and token ceilings (LL-05), an exact-match cache (LL-06), shadow checks and `pnpm local:bench` (LL-09), and local-path security (LL-08)

**Can wait**

- [ ] P2 agents, MCP, sandbox, sync, dictation (after P1.5)
- [ ] P3 voice conversation, image generation, auth and billing hooks turned on
