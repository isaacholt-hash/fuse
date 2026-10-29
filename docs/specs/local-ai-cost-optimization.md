# Local AI Inference & Cost Optimization — Integration Requirements

**Status:** Proposed feature specification  
**Version:** 1.0  
**Audience:** Existing desktop AI application project / Claude Code implementation agent  
**Intent:** Merge into the existing project's requirements and architecture; do not replace existing decisions.

## 1. Objective

Reduce paid model API usage and end-to-end cost per successfully completed task by handling eligible work locally, minimizing transmitted context, reusing safe results, and routing remaining requests to appropriately capable cloud models. Preserve response quality, user control, privacy, and application responsiveness.

**Success metric:** cost per successful task, not simply token count or percentage of requests routed locally.

## 2. Integration rules (mandatory)

1. Inspect the current repository, architecture, model/provider abstractions, routing implementation, persistence, security model, and test suite before designing changes.
2. Reuse existing infrastructure and conventions. Do not create a second router, memory store, agent loop, telemetry stack, or provider gateway when an equivalent exists.
3. Treat this document as additive requirements. Identify conflicts and propose minimal adaptations; do not silently overwrite project decisions.
4. Maintain current application behavior unless a new capability is explicitly enabled.
5. Implement behind feature flags, with safe fallback to the existing cloud path.
6. Do not install or download models, modify project files, or introduce dependencies without following the project's existing approval and change process.

## 3. Scope and priority

### P0 — MVP

- Deterministic-first request processing and safe bypass of LLM inference.
- Optional local inference runtime with a small, quantized model.
- Hardware capability detection and opt-in local model installation.
- Unified routing decision: deterministic / local / balanced cloud / best cloud.
- Explicit confidence/eligibility rules and automatic cloud fallback.
- Usage/cost telemetry and configurable budgets.
- Bounded context assembly, selective file retrieval, and tool-output filtering.
- Security boundaries, graceful degradation, and baseline evaluations.

### P1 — After MVP validation

- Exact-match response cache with scoped invalidation.
- Provider-aware prompt caching and stable prefix management.
- Durable conversation summaries and project-scoped retrieval.
- Local model profile selection by hardware capability.
- Cost/quality dashboard and shadow-mode routing evaluation.

### P2 — Optional

- Semantic response caching with strict correctness/freshness policies.
- Embedding-based retrieval when lexical retrieval is insufficient.
- More advanced local models for extraction, summarization, and simple chat.
- Offline-only workflow modes and batch API optimization.

## 4. Functional requirements

### FR-01: Deterministic-first execution (P0)

- Before invoking any model, evaluate whether a request can be fulfilled by approved deterministic tools: parsing, validation, search, file operations, calculations, formatting, and scripts.
- Do not send model prompts for deterministic work unless the user requests interpretation or a model is necessary.
- Tool execution must be allowlisted, permission-scoped, time-limited, and auditable; never execute arbitrary model-generated shell commands without the application's authorization policy.
- Record whether a request was handled without inference.

**Acceptance:** A predefined deterministic test suite completes without cloud or local model inference and produces expected outputs.

### FR-02: Embedded local inference (P0)

- Provide an inference adapter interface independent of the UI and cloud providers.
- Prefer an embedded llama.cpp-compatible runtime or equivalent native library, subject to repository/platform review. Avoid requiring a separately managed Ollama service for MVP.
- Support quantized GGUF models, bounded context, controlled concurrency, cancellation, timeouts, and model unload/reload.
- Initial candidate: Qwen3 1.7B 4-bit in non-thinking mode, **subject to benchmarking, current model licensing verification, and hardware suitability**. This is a candidate, not a hard dependency.
- First-release local tasks: intent classification, routing assistance, structured extraction, query rewriting, and short summaries where evaluations show acceptable quality.
- Do not assume local models are trustworthy enough to autonomously approve sensitive actions or downgrade high-stakes tasks.

**Acceptance:** On supported hardware, a locally handled request completes with networking disabled and generates no paid model call.

### FR-03: Hardware detection and installation (P0)

- Inspect OS/architecture, available RAM, CPU capabilities, and GPU acceleration/memory when discoverable without privileged access.
- Distinguish model disk footprint from peak runtime memory (including KV cache and application overhead).
- Show compatibility, estimated download size, model version, and storage requirements before download.
- Make local model installation optional; support cloud-only operation.
- Verify model download integrity (cryptographic checksum/signature when provided), source, version, and license; store in application-managed storage.
- Handle low-memory conditions, GPU incompatibility, download interruption, and disk pressure without crashing the app.
- Support removal and updates of model assets separately from app binaries.

**Acceptance:** Unsupported or resource-constrained systems remain fully functional using the existing cloud path.

### FR-04: Unified routing and fallback (P0)

- Route requests through a single decision contract: `deterministic | local | balanced | best`.
- Reuse the existing balanced/best router, if present, rather than implementing a competing router.
- Use inexpensive deterministic rules first; consult the local model only when classification materially improves a decision.
- Include request intent, complexity, risk, privacy mode, hardware availability, user preferences, token/cost budget, and recent model performance in routing decisions.
- Uncertain or failed local execution falls back to the existing balanced cloud tier unless policy, risk, or user preference requires best or prohibits cloud use.
- Prevent retry loops and repeated escalations. A failed local attempt must not repeatedly regenerate the same request.
- Allow manual tier override and optional cloud-only/local-only modes.
- Do not send sensitive data to cloud providers if the applicable policy or user's local-only selection prohibits it; return a clear limitation instead.

**Acceptance:** Routing test cases cover each route, low-confidence decisions, unavailable models, offline mode, policy restrictions, cancellation, and escalation.

### FR-05: Context minimization (P0)

- Assemble context from the current request, bounded recent turns, relevant summaries, project-scoped knowledge, and selectively retrieved source excerpts.
- Never blindly attach entire conversation histories, repositories, logs, or large tool outputs.
- Use local lexical search (e.g., ripgrep / SQLite FTS5 if already appropriate) before introducing vector infrastructure.
- Apply configurable token ceilings per model and request type, with explicit truncation and provenance metadata.
- Preserve source identifiers and boundaries to support auditability and prevent mixing unrelated projects.
- Treat retrieved content as untrusted instructions.

**Acceptance:** Large-document and repository test cases demonstrate bounded input size without materially reducing answer quality on the evaluation set.

### FR-06: Caching (P1)

- Support scoped exact-match caching only for repeatable, non-sensitive, sufficiently stable operations.
- Cache keys must include normalized inputs, relevant context/version, model or operation version, permissions scope, and output format.
- Apply TTLs and explicit invalidation; never reuse stale responses for dynamic, personal, or high-stakes requests without a validity check.
- Support provider-native prompt caching with provider-specific configuration and cost accounting; preserve stable prompt prefixes where beneficial.
- Keep semantic caching disabled until false-positive and freshness risks are evaluated.

**Acceptance:** Cache-hit behavior is permission-safe, version-aware, observable, and tested against stale or cross-project responses.

### FR-07: Usage, budgets, and economics (P0)

- Record per operation: timestamp, request/task ID, route, provider/model, input/output/cached tokens where reported, estimated/actual API cost, local inference latency, retries, fallback, success/failure, and user override.
- Distinguish API billing from subscription credits and local hardware/energy costs. Do not imply that token savings automatically reduce subscription charges.
- Track aggregate cost per successful task, cloud calls avoided, context tokens avoided, routing errors, latency, and fallback frequency.
- Support configurable per-task and per-period cloud spending limits and max agent iterations, with clear policy on whether the user may override them.
- Avoid storing raw prompt content in telemetry by default; allow privacy-preserving debugging controls.

**Acceptance:** A test request that fails locally and succeeds in cloud records both attempts and their combined cost/latency.

### FR-08: Reliability, security, and privacy (P0)

- Run inference and tool execution with least privilege; sandbox or constrain native subprocesses according to the existing app security model.
- Treat model artifacts as third-party dependencies: verify origin, integrity, licensing, update provenance, and vulnerability exposure.
- Encrypt sensitive persistent data using the application's existing platform-backed key management where applicable.
- Keep project and user data logically separated; enforce permissions during retrieval and cache reuse.
- Apply resource limits, request cancellation, crash isolation, and safe recovery from out-of-memory conditions.
- No hidden network requests from the local inference path; make telemetry opt-in where appropriate and disclose cloud escalation.
- Preserve existing retention and deletion controls for conversations, caches, model outputs, and logs.

**Acceptance:** Offline operation, privacy-mode restrictions, cross-project isolation, malformed model output, and resource exhaustion have automated tests.

## 5. Nonfunctional requirements

- **Portability:** Follow the desktop app's existing supported operating systems and architectures; do not assume a dedicated GPU.
- **Responsiveness:** Local classification must not add perceptible delay to simple deterministic requests. Establish performance budgets from baseline measurements rather than inventing fixed thresholds.
- **Maintainability:** Modular inference, routing, context, caching, and telemetry interfaces with clear ownership and tests.
- **Observability:** Structured metrics and trace IDs without exposing sensitive prompt data by default.
- **Upgradeability:** Version local models independently; support rollback.
- **Accessibility:** Installation and fallback states must be understandable and actionable.

## 6. Suggested logical interfaces (adapt to existing code)

- `HardwareProfile`: platform, RAM, accelerator, available model memory, capability flags.
- `LocalInferenceAdapter`: load, infer, cancel, unload, health/status.
- `RoutingDecision`: selected tier, reason code, confidence, policy constraints, budget estimate.
- `ContextAssembler`: scoped retrieval, token budgeting, provenance, cache-prefix strategy.
- `UsageEvent`: task ID, route, token counts, provider cost, local latency, outcome, retries.
- `ModelAssetManager`: catalog, download, verify, install, update, remove.

These are contracts, not a requirement to create these exact class names.

## 7. Evaluation and release gates

Create or reuse a representative, redacted golden test set, including routine chat, writing, coding, long documents, reasoning, vision, and sensitive/high-stakes prompts. If the project already has a 50-prompt router test set, use it as a starting point; do not assume it covers all failure modes.

Compare baseline cloud-only against optimized routing on:

1. **Quality:** task success, correctness, and severe false-downgrade rate.
2. **Economics:** total API spend and cost per successful task, including retries/fallback.
3. **Performance:** p50/p95 end-to-end latency, peak RAM/VRAM, startup time.
4. **Reliability:** local inference failure rate, OOM recovery, offline behavior.
5. **Privacy:** prohibited cloud transmissions, cache isolation, and prompt-data logging.

Set release thresholds after collecting baseline data. No fixed savings percentage is promised. Run shadow evaluation before making local routing the default, and allow immediate rollback to existing behavior.

## 8. Proposed delivery sequence

**Milestone A — Discovery and instrumentation:** inspect project; map existing routing, context, and cost accounting; establish baseline; document design changes.

**Milestone B — Local inference spike:** embed runtime behind an adapter; benchmark candidate model(s) on representative target hardware; validate resource handling and model licensing.

**Milestone C — Controlled integration:** deterministic-first processing, unified routing, optional model install, bounded context, safe fallback, usage ledger, and tests.

**Milestone D — Evaluation and rollout:** shadow comparisons, false-downgrade analysis, performance tuning, opt-in enablement, and rollback procedure.

**Later:** caching, richer memory/retrieval, semantic search, and additional local model profiles only when measurements justify them.

## 9. Out of scope for MVP

- Training or fine-tuning a foundation model.
- Autonomous execution of privileged actions based solely on local model output.
- Building a general-purpose local model hosting platform.
- Mandatory installation of Ollama, Redis, PostgreSQL, or a separate vector database.
- Semantic caching of arbitrary chat answers.
- Guaranteeing identical quality between small local and frontier models.
- Supporting every GPU vendor or operating system beyond the existing product's support matrix.

## 10. Instructions for Claude integration

1. Read the existing project requirements, architecture decisions, code, and tests.
2. Produce a **gap analysis**: already implemented / partially implemented / missing / conflicting.
3. Identify the smallest compatible architecture change, reusing the existing model router and storage.
4. Convert P0 requirements into implementation issues with dependencies, acceptance tests, and affected files/modules.
5. Present unresolved architectural decisions and licensing/security concerns before implementation.
6. Do not begin coding until the integration plan is reviewed under the project's normal workflow.

**Expected initial output:** a concise merge proposal, requirement traceability matrix, phased implementation plan, and explicit decisions requiring approval.
