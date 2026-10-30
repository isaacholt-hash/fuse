# M7 — Local and lean (P1.5 part 3)

**Goal:** cut what each finished task costs without lowering quality (requirements §16b, LL-01 to LL-09). Answer what needs no model without one. Do housekeeping on a small model built into FUSE. Send less context. Reuse safe results. All of it reuses the one router, request log, context assembler and egress policy; nothing is built twice.

**Done when:** the P1.5 gate (§3) passes in tests: on the routing test set, cost per successful task is lower than the cloud-only baseline with no quality drop, and a Local only project makes no cloud call. Isaac then runs `pnpm local:bench` on his PC for the live numbers.

**Out of scope:** local answers to chat (LL-10, needs RT-17 changed), semantic caching, GPU acceleration (Vulkan comes after the CPU build), an Ollama or LM Studio adapter, and P2.

## Decisions (Isaac, 2026-10-30)

- **Runtime:** llama.cpp built into FUSE through Rust (`llama-cpp-2`), CPU first. It runs in a worker process that FUSE starts from its own executable, so running out of memory or a crash ends only the worker, never the app. There is no separate service to install.
- **Models:** two profiles, Qwen3 1.7B and Qwen3 4B (4-bit GGUF, non-thinking mode), chosen by hardware. Licence, source and checksum are verified when step 3 adds them to `data/`. Nothing is downloaded until Isaac installs it.
- **What local does:** housekeeping only (RT-17 kept): titles, the classifier's second opinion, memory suggestions, summaries, query rewriting.
- **When it's on:** as soon as a model is installed, with one switch to turn it off. Shadow results and the false-downgrade rate are still recorded (LL-09), but they don't gate turning it on.
- **Privacy modes:** already built in M5 (SE-13). M7 lets Local only projects do housekeeping locally.
- **M6 gate:** Isaac skipped the two-week trial on 2026-10-30 and moved straight to M7.

## Steps (one PR each, in order)

- [x] **0. M7 plan.** This file, the decisions in requirements §17, and CLAUDE.md pointed here.
- [x] **1. Cost per successful task (LL-07).**
  - A task is a question with all its answers, retries, escalations and regenerates, counted once. It succeeds when its newest answer finished, wasn't marked bad, and the question wasn't edited.
  - The Usage screen shows cost per successful task over 30 days (all API spend, housekeeping included, over the tasks that succeeded) and cloud calls avoided (request log rows from `local` or `deterministic`). Context tokens avoided are added with token ceilings in step 10.
  - The baseline is frozen from the request log the first time a task has succeeded with every call in the cloud (setting `economics.baseline`), with a Freeze again button. The routing test set's baseline is part of step 13.
- [ ] **2. Deterministic first (LL-01).**
  - Allowlisted handlers, run before routing: arithmetic, unit conversion, date and time conversion, counting, and JSON or CSV validation.
  - The answer is marked "answered without a model · $0" and logged with route `deterministic`.
  - Handlers are pure TypeScript, time-limited and audited, with no shell. They can be turned off per project.
  - A deterministic test suite passes with no model call.
- [ ] **3. A local provider in the catalog (LL-02, LL-08).**
  - `ProviderId` gains `local`. `data/local-models.json` lists the two profiles: file size, peak memory, context limit, licence, source URL, SHA-256 and `verified_on`.
  - Price is zero. Egress treats local as never leaving the computer.
  - A scripted local adapter is added for tests.
- [ ] **4. Runtime in Rust (LL-02).**
  - `local.rs` and a worker mode of the FUSE executable. Load, stream, cancel, time limit, unload and reload. One request at a time, a bounded context, CPU threads capped.
  - No network code on this path.
  - Checked on Linux here and on Windows in CI. Release builds need `cmake`, so CI installs it.
- [ ] **5. Hardware detection (LL-03).**
  - RAM, free memory, CPU features (AVX2 and others) and free disk, read without elevated rights.
  - Picks the profile: 4B when there's enough memory for its peak plus the app, otherwise 1.7B, otherwise none. Settings → Local model shows why.
- [ ] **6. Install, update and remove (LL-03, LL-08).**
  - Before download, the screen shows size, memory needed, licence and source.
  - The download can be resumed and is checked against its SHA-256 before use. It is stored in app data, apart from the app.
  - Remove and update. A bad checksum, a full disk or an interrupted download leaves the app working on the cloud path.
- [ ] **7. Local adapter (LL-02).**
  - The `ProviderAdapter` over the worker. Token counts are logged, with cost 0 and provider `local` in the request log.
  - Malformed or empty output is an error, never shown as text.
- [ ] **8. Routing to local (LL-04).**
  - When a model is installed, local is first choice in the Cheap tier for each housekeeping job. One fallback to the cloud Cheap model, with no retry loops; both attempts are logged as one task.
  - Local only projects get titles, summaries and memory suggestions locally. Chat there is still refused, with a clearer message.
  - The switch in Settings → Local model turns it all off at once.
- [ ] **9. Shadow and evaluation (LL-09).**
  - Some housekeeping jobs also run on the cloud model, sampled and off by default after a week, and both results are recorded.
  - A false-downgrade rate for the classifier's second opinion on the routing test set, plus p50/p95 latency and peak memory.
  - `pnpm local:bench` for Isaac's PC.
- [ ] **10. Smaller context (LL-05).**
  - FTS5 lexical search over file chunks and knowledge, as the default and the fallback, so search works without an OpenAI key. Embeddings are added when available.
  - Token ceilings per model and request type, with explicit truncation and the source recorded. The coding agent's tool outputs are capped the same way.
  - Large-document and repository tests show bounded input.
- [ ] **11. Exact-match cache (LL-06, RT-13).**
  - Keyed by normalised input, context version, model or operation version, project and output format, with TTLs and invalidation.
  - Never used in incognito, for answers that used web search, or for personal, dynamic or high-stakes requests. Tested for stale and cross-project hits.
- [ ] **12. Local-path security (LL-08).**
  - Tests: offline use, Local only, cross-project isolation, malformed output, out of memory, and the worker crashing mid-answer.
  - The threat model gets a section for local models and their files.
- [ ] **13. P1.5 gate test.**
  - Automated: on the routing test set, with recorded cloud responses and the scripted local adapter, cost per successful task is below the step 1 baseline with no quality drop, and a Local only project makes no cloud call.
  - Plus `pnpm local:bench` for the live numbers on Isaac's PC.

## Notes

- The usual rules apply to each step: one PR, tests, a screenshot for UI changes, the secret scan, `cargo fmt --check` and clippy when Rust changes, CI green, then merge.
- Model files are never committed and never fetched by tests. Tests use the scripted adapter. A small real model runs only in `pnpm local:bench`, after Isaac installs it.
- The worker inherits no provider keys and opens no sockets.
- Live numbers come from Isaac's PC, not HULK.
