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
- [x] **2. Deterministic first (LL-01).**
  - Fixed rules in `src/deterministic/handlers.ts` run before routing: arithmetic (with percentages), unit conversion (length, mass, volume, data, time, temperature), dates (weekday, days between, plus or minus days, a time between IANA zones), counting words, characters or lines, and JSON or CSV checks.
  - Each rule matches the whole question strictly. Anything with more to it goes to a model.
  - The answer shows "answered without a model · $0" and is logged with provider `deterministic` (migration 0036).
  - Pure TypeScript with no shell: input is capped at 100,000 characters, nesting at 50 levels, and a rule that takes over 100 ms is ignored. Only Auto sends with nothing attached are eligible. Each project can turn it off under Privacy.
  - A 29-question suite passes with no model call, plus 14 questions it must leave to a model.
- [x] **3. A local provider in the catalog (LL-02, LL-08).**
  - `ProviderId` gains `local`; `CloudProviderId` covers the providers with keys. `data/local-models.json` lists the two profiles with pinned revision, SHA-256, size, peak memory estimate, context limit and licence, verified from Hugging Face on 2026-10-30.
  - Both are official Qwen builds under Apache-2.0. Qwen3 4B is Q4_K_M (2.50 GB). Qwen ships Qwen3 1.7B only as Q8_0 (1.83 GB), so that profile is 8-bit, not 4-bit.
  - Local models are priced at zero. Egress allows local in Normal and Local only projects and refuses it in Cloud only ones.
  - The local adapter fails with a clear reason until a model is installed. `scriptedLocal` stands in for it in tests.
- [x] **4. Runtime in Rust (LL-02).**
  - `src-tauri/src/local_worker.rs`: the FUSE executable started with `--local-worker` runs llama.cpp (`llama-cpp-2` 0.1.160, CPU, OpenMP) and speaks JSON lines: load, generate (Qwen3 chat format, non-thinking, control tokens stripped from content), cancel.
  - `src-tauri/src/local.rs` starts it with an empty environment and no window, loads the model from `models/<file>` in the app's data folder, and streams one request at a time.
  - Stop, a time limit (2 min by default; cancel, then end the worker after 3 s), unload, and a worker that dies mid-answer all end with a clear error while the app keeps running.
  - llama.cpp is built with AVX2, FMA and F16C (`.cargo/config.toml`). The worker refuses a CPU without them, and llama.cpp is built without curl.
  - Checked on HULK with the real Qwen3 1.7B file (SHA-256 matched): it loaded, wrote a 7-word chat title using about 4 s of CPU, and peaked at 2.4 GB on a 585-token prompt. Building needs `cmake` and `clang` (both on HULK and the CI runners).
- [x] **5. Hardware detection (LL-03).**
  - `src-tauri/src/hardware.rs` (`sysinfo` 0.39.6) reads total and free memory, logical CPUs, AVX2, FMA and F16C, and free space on the disk holding the app's data, without elevated rights.
  - `src/local/hardware.ts` picks the largest profile whose estimated peak memory is within 40% of RAM and whose file fits with 1 GB of disk to spare. It picks none without AVX2 or on a non-x86-64 CPU, and warns when less memory is free now than the model needs.
  - Settings → Local model shows this computer, the choice and why, and the profile's size, memory, licence and source. On HULK (15.9 GB): Qwen3 4B.
- [x] **6. Install, update and remove (LL-03, LL-08).**
  - `src-tauri/src/model_files.rs`: a download comes only from `https://huggingface.co/…/resolve/<40-hex revision>/<file>`, over HTTPS only. It goes to `models/<file>.part`, resumes with a Range request, and is checked against its size and SHA-256 (hashed end to end, resumed bytes included) before it's renamed into place with a `<file>.gguf.json` note.
  - Free disk is checked first (the file plus 1 GB). A bad checksum or an oversized download deletes the partial file. A dropped connection or Pause keeps it for resuming.
  - Settings → Local model: Download and install, progress with Pause, Update when `data/local-models.json` names a newer build, Remove (which ends the worker first), and other model files on this computer.
  - Checked on HULK through the app: the 2.50 GB Qwen3 4B file downloaded, matched its SHA-256 and installed. Hugging Face's CDN answers Range requests with 206, so resuming works.
- [x] **7. Local adapter (LL-02).**
  - `src/providers/local/adapter.ts`: `createLocalAdapter` is the `ProviderAdapter` over the worker (`tauri.ts` calls `local_generate` and `local_cancel`). Text only, output capped at 1,024 tokens, a 2-minute time limit.
  - Token counts come from llama.cpp; the cost is zero, priced from the zero catalog price. A length stop reads as `max_tokens`. A stray thinking block is removed, and the answer is held back until the end so it never shows.
  - Not installed, a worker error or crash, or an empty answer is a `ProviderError` (`unavailable` or `stream`), never shown as text. Stop cancels the worker and ends as `aborted`.
- [x] **8. Routing to local (LL-04).**
  - `housekeepingCall` tries the installed local model first for titles, summaries, memory suggestions and the classifier's second opinion. If that fails, it tries the request's cloud Cheap model once: two attempts at most, each logged. With no cloud key, the local model does housekeeping alone.
  - Local only projects do housekeeping locally, and nothing goes to the cloud if it fails. Cloud only projects never use it. Chat in Local only projects is still refused, with a message saying the local model only does housekeeping (fixed-rule answers still work). The privacy wording is updated.
  - Settings → Local model has one switch, "Use the local model for housekeeping" (setting `local.enabled`, on by default), that sends everything back to the cloud at once.
  - A failed local attempt doesn't count as a cloud call avoided. Coding-run summaries stay on the cloud Cheap model.
- [x] **9. Shadow and evaluation (LL-09).**
  - Shadow checks (migration 0037): for 7 days after install, about 1 in 10 housekeeping jobs the local model finished also runs, in the background, on the cloud Cheap model. Only timings, lengths and agreement are kept, never the text. Nothing is checked when the project blocks the cloud. Settings → Local model shows the results.
  - `pnpm local:bench` runs FUSE's real worker (the newest build) on the installed model, or `FUSE_LOCAL_MODEL`. It covers the shipped routing test set (`data/routing-test/prompts.jsonl`: 40 synthetic prompts, 35 standalone) and five chats to title. It reports parse rate, tier accuracy against the heuristics alone, false downgrades, p50/p95 latency and peak memory. No key, no network, $0.
  - HULK, Qwen3 1.7B (Q8_0), debug build: 97% of replies parsed; the tier was right 86% of the time with the local check, against 80% for the heuristics alone; 3% false downgrades; about 3.1 s per classification; 4 of 5 titles usable; 2.43 GB peak.
  - The bench caught the 1.7B model copying the title prompt's example ("Lisbon trip with kids") for unrelated chats. The example is gone from the prompt, and a title must now share a word with the question to count.
- [x] **10. Smaller context (LL-05).**
  - FTS5 over file chunks (migration 0038, kept up to date by triggers). Large attached files and project knowledge are searched by their words on this computer (BM25), so this works with no OpenAI key and in projects that don't allow embedding.
  - With an embedding model, the word and meaning rankings are merged (reciprocal rank fusion), and an embedding failure falls back to words. The send-time "needs an OpenAI key" block is gone, and knowledge files without embeddings read "Searchable by word".
  - Token ceilings as data (`data/context.json`). A chat request stays under the smaller of 400K tokens and 75% of the model's context. Past it, the oldest messages are left out, the request says so, and the context package records a `trimmed` part. Housekeeping input is capped at 8K tokens, and the local model's at 2.5K, each with a marker.
  - Coding-run tool outputs were already capped at 40,000 characters (M6).
  - Tests: a 1,200-section manual (about 27K tokens) gets about 3K tokens of on-topic, cited excerpts with no key.
- [ ] **11. Exact-match cache (LL-06, RT-13).**
  - Keyed by normalised input, context version, model or operation version, project and output format, with TTLs and invalidation.
  - Never used in incognito, for answers that used web search, or for personal, dynamic or high-stakes requests. Tested for stale and cross-project hits.
- [ ] **12. Local-path security (LL-08).**
  - Tests: offline use, Local only, cross-project isolation, malformed output, out of memory, and the worker crashing mid-answer.
  - The threat model gets a section for local models and their files.
- [ ] **13. P1.5 gate test.**
  - Automated: on the routing test set, with recorded cloud responses and the scripted local adapter, cost per successful task is below the step 1 baseline with no quality drop, and a Local only project makes no cloud call.
  - Plus `pnpm local:bench` for the live numbers on Isaac's PC.

## Fixes found in use

Done right after step 2 and before step 3. One small PR each.

- [ ] **F1. The update notice shows up only after a restart (PL-06).** Isaac reported this on 2026-10-30.
  - Cause: `useUpdate` checks once at startup and then every 6 hours. Releases ship several times a day, so the bar usually appears only on the next launch. Also, Dismiss hides every later release for the rest of the session.
  - Fix: check every 30 minutes and whenever the window regains focus (at most once every 5 minutes). Dismiss hides only the version it was clicked on. If a newer release comes out after one was downloaded, download the newer one. Add a "Check for updates" button next to the version in Settings.
  - Tests use a fake `UpdateApi` and fake timers. No real release is fetched.

## Notes

- The usual rules apply to each step: one PR, tests, a screenshot for UI changes, the secret scan, `cargo fmt --check` and clippy when Rust changes, CI green, then merge.
- Model files are never committed and never fetched by tests. Tests use the scripted adapter. A small real model runs only in `pnpm local:bench`, after Isaac installs it.
- The worker inherits no provider keys and opens no sockets.
- Live numbers come from Isaac's PC, not HULK.
