# Fuse — Product and Solution Requirements

**Status:** Draft for review  
**Version:** 0.1  
**Date:** 2026-10-28

## 1. Product vision

Fuse is a model-agnostic desktop AI workspace that maintains continuity across sessions and model providers, intelligently routes tasks to suitable models, and optionally uses lightweight local inference to reduce latency, cloud usage, and cost.

**Core promise:** Users retain control of their AI context and can switch models without losing project knowledge, decisions, or working state.

## 2. Goals and non-goals

### Goals
- Preserve project context, user preferences, decisions, and artifact references across sessions.
- Make the memory layer independent of any single model provider.
- Support local-only data storage by default, with opt-in encrypted multi-device sync.
- Route tasks based on capability, estimated cost, latency, privacy policy, and user preferences.
- Offload appropriate low-risk operations to an optional local model.
- Make storage, memory use, model selection, and spending transparent and controllable.

### Initial non-goals
- Replacing every feature of ChatGPT, Claude, or other first-party applications.
- Automatically importing private account memory from providers without an authorized export or API.
- Training proprietary foundation models.
- Enterprise-wide collaboration, billing, or governance in the first release.
- Fully autonomous execution of consequential actions without explicit authorization.

## 3. Target users

**Primary:** Heavy individual AI users who work across multiple models and projects and value continuity, cost visibility, and data control.

**Secondary (later):** Small teams and security-conscious organizations requiring shared context, access controls, and auditability.

## 4. Functional requirements

Priority: **P0** = MVP; **P1** = post-MVP; **P2** = later.

| ID | Priority | Requirement | Acceptance criterion |
|---|---|---|---|
| FR-01 | P0 | Maintain persistent projects and conversations. | Closing and reopening Fuse preserves project state and conversation history. |
| FR-02 | P0 | Store structured memory: facts, preferences, constraints, decisions, tasks, and source references. | Each record includes type, scope, timestamps, provenance, and update status. |
| FR-03 | P0 | Support user review, correction, deletion, and exclusion of memories. | Users can inspect why a memory was retrieved and remove it from future context. |
| FR-04 | P0 | Assemble relevant context for each request without sending the entire memory store. | Context selection respects project scope, token budget, and privacy settings. |
| FR-05 | P0 | Provide adapters for at least two cloud model providers. | The same project can be used with either provider without re-importing project state. |
| FR-06 | P0 | Offer explicit model selection and configurable automatic routing. | Users can override routing and see the selected model and reason. |
| FR-07 | P0 | Estimate and track cloud model usage and cost. | Per-request and project-level cost estimates are visible, with actuals where available. |
| FR-08 | P0 | Persist local structured data in SQLite and artifacts in a managed local directory. | Database and artifact references survive application restarts and remain consistent. |
| FR-09 | P0 | Allow local-only operation for memory storage. | No memory or artifact content is uploaded to Fuse-operated services in local-only mode. |
| FR-10 | P0 | Provide export and import in documented, portable formats. | A user can export and restore a project with memories, metadata, and artifacts. |
| FR-11 | P0 | Enforce provider-specific privacy and transmission rules. | Content blocked from a provider is not sent to that provider, including via fallback. |
| FR-12 | P1 | Support a lightweight optional local model. | Eligible tasks can execute locally; cloud fallback requires policy permission. |
| FR-13 | P1 | Support opt-in encrypted multi-device synchronization. | Changes from two devices converge without silently overwriting conflicting edits. |
| FR-14 | P1 | Import authorized provider conversation exports. | Imports retain source attribution, avoid duplicate ingestion, and permit review before memory promotion. |
| FR-15 | P1 | Provide semantic retrieval over project memory and artifacts. | Relevant information can be retrieved without requiring exact keyword matches. |
| FR-16 | P1 | Support model routing evaluation and quality checks. | Routing can be tested against a labeled prompt set for quality, cost, and latency. |
| FR-17 | P1 | Support configurable per-user and per-project budgets. | Warnings and optional hard stops trigger at configured limits. |
| FR-18 | P2 | Offer collaboration and shared project permissions. | Authorized members can access only permitted projects and records. |
| FR-19 | P2 | Offer customer-managed sync destinations where feasible. | Supported destinations are documented and tested for reliability and recovery. |

## 5. Canonical memory data model

The internal data model must be **provider-neutral**. Provider adapters translate canonical context into each provider's supported request format; provider-specific message schemas must not become the system of record.

### Core entities

| Entity | Purpose | Key attributes |
|---|---|---|
| User | Preferences and ownership | id, preferences, policy references |
| Workspace | Logical boundary | id, owner, settings |
| Project | Persistent work context | id, workspace_id, name, lifecycle_state |
| Conversation | Session history | id, project_id, provider, timestamps |
| Message | User/model/tool exchange | id, conversation_id, role, content reference, model, timestamp |
| Memory | Durable contextual information | id, scope, type, content, confidence, status, provenance |
| Decision | Explicit project choices | id, project_id, rationale, alternatives, status, supersedes_id |
| Task | Work state | id, project_id, owner, status, dependencies |
| Artifact | File or generated output | id, project_id, path, MIME type, checksum, version |
| Source | Provenance | id, provider, conversation/message/artifact reference |
| ModelRun | Inference telemetry | id, model, provider, token counts, cost, latency, outcome |
| SyncEvent | Replication record | id, device_id, entity, operation, revision, timestamp |

### Required data-model behaviors
- Scope memory to global, workspace, project, or conversation level.
- Separate **raw conversation history** from **promoted durable memory**.
- Track source, extraction method, confidence, last verification, and supersession.
- Support contradictory facts, correction, expiration, and explicit deletion.
- Version the schema and support forward migrations and tested rollback/recovery.
- Keep sensitive data classifications and transmission permissions alongside records.
- Use stable identifiers; avoid embedding provider IDs as canonical primary keys.

## 6. Proposed architecture

```text
Desktop UI
   |
Application / orchestration layer
   |-- Project and conversation manager
   |-- Memory extraction and retrieval
   |-- Context assembly and token budgeting
   |-- Policy enforcement / consent
   |-- Intelligent model router
   |      |-- Local inference adapter (optional)
   |      |-- OpenAI adapter
   |      |-- Anthropic adapter
   |      `-- Additional provider adapters
   |-- Usage / cost telemetry
   `-- Optional sync engine
          |
Local persistence
   |-- SQLite: metadata, state, memory, decisions, sync log
   |-- Local artifact directory: documents and attachments
   `-- Optional local vector index / SQLite vector extension
          |
Optional encrypted sync transport
   `-- Cloud relay / user-approved storage destination
```

**Design rule:** One logical memory system, not one monolithic file. Keep structured records in SQLite and large binary artifacts in the filesystem. Use content hashes and database references to maintain integrity.

## 7. Local storage and synchronization

### Local storage (P0)
- Use SQLite with transactional writes and migrations.
- Store large files outside the database, referenced by immutable or versioned identifiers.
- Encrypt sensitive local data at rest using a maintained encryption approach; protect keys with the operating system credential store where supported.
- Provide local backup, restore, integrity checks, and export.
- Support explicit local-only mode, with network egress limited to approved inference requests.

### Optional multi-device sync (P1)
- Synchronize **logical records and versioned artifacts**, not a live SQLite database file.
- Encrypt data on the client before uploading to the sync service when end-to-end encrypted sync is enabled.
- Use per-device identity, authenticated sessions, incremental change logs, and resumable transfers.
- Use deterministic merge rules for nonconflicting changes; flag competing edits to decisions or canonical facts for review.
- Define deletion propagation, device revocation, recovery, and lost-key behavior.
- Provide clear backup-versus-sync semantics: sync alone is not backup.
- Test offline edits, interrupted uploads, duplicate events, concurrent changes, and restoration on a new device.

## 8. Context and memory pipeline

1. Capture conversations and relevant artifacts with source metadata.
2. Identify candidate memories, decisions, constraints, and tasks.
3. Deduplicate and compare candidates against existing records.
4. Promote candidates according to confidence and user-configured approval policy.
5. Retrieve relevant records by project, recency, authority, and semantic relevance.
6. Assemble a bounded context package with provenance and explicit constraints.
7. Apply privacy policy **before** transmitting context to a provider.
8. Record model output, usage, and resulting state changes.

**Important:** Memory extraction is not inherently trustworthy. Model-generated summaries must not silently override explicit user decisions or higher-authority source records.

## 9. Intelligent routing and local inference

### Routing inputs
- Task classification and estimated reasoning complexity.
- Available models, capabilities, and context limits.
- User preference and provider allow/deny policies.
- Estimated tokens, latency, and monetary cost.
- Required data locality and sensitivity.
- Measured quality from a maintained evaluation set.

### Local model use cases
- Task classification and routing assistance.
- Summarization of non-sensitive or locally permitted material.
- Memory candidate extraction and tagging.
- Search-query generation and context compression.
- Simple transformations where benchmarked quality is sufficient.

### Guardrails
- Detect local hardware capability and provide an opt-out.
- Bound CPU, GPU, RAM, and battery usage.
- Measure local inference quality rather than assuming it is adequate.
- Require explicit permission before moving locally restricted data to cloud inference.
- Account for local execution time, energy, and support burden when claiming cost savings.

## 10. Security and privacy requirements

| ID | Requirement |
|---|---|
| SEC-01 | Minimize collection; make memory retention and cloud transmission configurable. |
| SEC-02 | Encrypt data in transit and sensitive data at rest. |
| SEC-03 | Store provider API keys securely; never log secrets or embed them in exports. |
| SEC-04 | Apply project-level data boundaries and provider-specific egress policies. |
| SEC-05 | Treat imported documents, retrieved content, and tool output as untrusted; defend against prompt injection. |
| SEC-06 | Require explicit authorization for destructive or externally consequential tool actions. |
| SEC-07 | Record relevant security and data-access events without logging unnecessary sensitive content. |
| SEC-08 | Provide deletion, export, device revocation, and documented retention behavior. |
| SEC-09 | Define threat models for local compromise, sync compromise, malicious imports, and provider exposure. |
| SEC-10 | Publish clear boundaries: local storage does not imply local inference, and cloud inference still transmits selected content. |

## 11. Provider integration

- Start with OpenAI and Anthropic through their supported commercial APIs; expand only after core behavior is validated.
- Keep adapters responsible for message formatting, tool schemas, model discovery, error handling, streaming, and usage accounting.
- Verify current API terms, rate limits, data handling, caching behavior, and commercial redistribution requirements before launch.
- Do **not** assume ChatGPT or Claude consumer subscriptions include transferable API credits or full account-memory access.
- Support user-supplied API credentials as a possible early commercial model, subject to provider terms.
- Treat provider exports as historical imports, not automatically synchronized live account memory.

## 12. Nonfunctional requirements

- **Reliability:** Local project data remains available without Fuse cloud connectivity.
- **Performance:** Set measurable latency targets after baseline testing; retrieval should not dominate normal response time.
- **Recoverability:** Test backup and restore, schema migration, and artifact integrity.
- **Portability:** Document the export format and ensure another implementation can parse it.
- **Observability:** Capture routing decisions, retrieval hits, errors, latency, and cost without exposing private content unnecessarily.
- **Extensibility:** Add providers without changing the canonical data model.
- **Maintainability:** Favor established libraries and a modular desktop architecture over microservices for the MVP.

## 13. MVP scope and phased delivery

### Phase 0 — Validate before significant build
- Interview 10–15 frequent multi-model users.
- Test whether context continuity is a repeated, costly problem and whether users will pay for it.
- Review provider API terms and cost structures.
- Build a small benchmark set of real cross-session workflows.
- Establish a credible pricing and unit-economics model.

### Phase 1 — Local-first MVP
- Desktop workspace with projects and conversations.
- Canonical SQLite memory model and local artifact storage.
- Memory review, correction, deletion, and context retrieval.
- OpenAI and Anthropic adapters.
- Basic model selection/routing, cost tracking, and export/import.
- Privacy controls and local backup/restore.

### Phase 2 — Differentiation
- Local lightweight model for selected operations.
- Semantic retrieval and more advanced routing.
- Encrypted multi-device sync.
- Provider history imports and migration tooling.
- Automated routing and context-quality evaluation.

### Phase 3 — Commercial expansion
- Subscription and usage-based commercial packaging.
- Team workspaces, policy administration, and audit capabilities.
- Additional model providers and supported storage destinations.

## 14. Validation gates

These thresholds are **proposed decision criteria**, not proven market benchmarks.

| Gate | Test | Proposed pass condition |
|---|---|---|
| Demand | Interview 10–15 target users | At least 8 report recurring cross-model continuity pain and 5 agree to test a prototype. |
| Willingness to pay | Show working workflow and price offer | At least 3 qualified users commit to a paid pilot or equivalent credible purchase intent. |
| Technical feasibility | Move a project between two providers | Critical decisions and constraints remain accurate in at least 90% of benchmark scenarios. |
| Economics | Model representative heavy-user usage | Target gross margin remains viable under realistic high-usage scenarios; validate actual cost distribution. |
| Security | Threat-model and test local/sync architecture | No unresolved critical vulnerabilities or unauthorized provider egress in tested scenarios. |
| Usability | Observe users completing continuity workflows | Most testers can resume a project on another model without manually reconstructing context. |

**Go/no-go rule:** Do not expand into paid cloud inference bundles, enterprise features, or complex synchronization until users demonstrate repeat usage and credible willingness to pay for continuity.

## 15. Open decisions

1. **Desktop framework:** Choose based on existing Fuse codebase, packaging, and OS support.
2. **Encryption:** Select maintained local database/file encryption and key-management implementation.
3. **Memory approval:** Determine which extracted memories can be auto-promoted versus requiring review.
4. **Sync topology:** Decide whether Fuse-hosted encrypted sync is sufficient initially or customer-owned destinations are necessary.
5. **Commercial model:** Compare bring-your-own-key subscriptions with bundled inference; avoid assuming enterprise API agreements are required for MVP.
6. **Initial platforms:** Confirm Windows/macOS/Linux support and hardware thresholds for local inference.

## 16. Immediate next actions

1. Compare these requirements with Fuse's existing architecture and backlog; identify overlap and gaps.
2. Implement the canonical memory schema and provider-neutral context assembly behind stable interfaces.
3. Build a two-provider continuity test using realistic project histories.
4. Validate customer demand and unit economics before committing to cloud sync or a bundled inference subscription.
