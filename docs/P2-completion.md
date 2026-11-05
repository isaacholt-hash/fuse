# Finish FUSE P2

Approved by Isaac on 2026-11-05. Finish every P2 **Must** and **Should** requirement under
previously approved boundaries, then record release and owner acceptance. This file and
M13–M19 are the approved execution plan; optional **Nice** items remain a visible backlog.

## Start and execution order

- [x] **Merge M12.** PR #286 merged as `c9f877ee922d45c9f9f69ff8fa55cbb025496f98` after all five checks passed on `f59653c551dd3a6ef563173743fbddc9c38c154f`. Normal release [v0.1.211](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.211) published successfully by [run 41947956851](https://github.com/isaacholt-hash/fuse/actions/runs/41947956851); Windows/Linux installers and updater manifest verified. M12's screenshots and platform limits remain in its milestone.
- [x] **Record the P2 roadmap.** This contract, requirement mapping, seven milestones and unattended authorization. Documentation-only; no new feature is marked built.

| Order | Milestone | PR steps |
| --- | --- | --- |
| 1 | [M13 Dictation](milestones/M13-dictation.md) | Accounting; capture/transport; controls and release |
| 2 | [M14 Deep research](milestones/M14-deep-research.md) | Routing/search; engine; Chat controls; benchmark/release |
| 3 | [M15 Connectors](milestones/M15-connectors.md) | Native accounts/MCP; Microsoft; GitHub; setup/verification |
| 4 | [M16 Coding completion](milestones/M16-coding-completion.md) | Review; named skills; scripts; child worktrees; reviewed integration |
| 5 | [M17 Writing/artifacts](milestones/M17-writing-artifacts.md) | Context tools/retrieval; canvas/comments; Python artifacts |
| 6 | [M18 Offline/usage](milestones/M18-offline-usage.md) | Queue; reconnect; reporting; reconciliation/activity |
| 7 | [M19 P2 acceptance](milestones/M19-p2-acceptance.md) | Integrated verification; released owner acceptance |

Use one `codex/*` branch and PR for each numbered step, from integrated main. Tick its box
in that PR, attach it to the Codex chat, follow `ship-step` and merge only with all five CI
gates successful on the current commit. Continue unattended through all steps; this approval
overrides the usual stop after each merge. Fix scoped failures. Stop only for an unresolved
product decision, unavailable required access or a failure that cannot safely be resolved.
Never bypass checks. Preserve other worktrees and existing benchmark gates.

## Requirement coverage

This maps every P2 Must/Should row and the P2 context/cost extensions. Completed work retains
its existing milestone evidence. A capability supported by infrastructure alone is not marked
complete when a dedicated flow remains missing. `MM-12` is Nice but required here by CO-06.

| Requirement | Existing evidence / remaining delivery |
| --- | --- |
| RT-14, AG-06 staged routing | M6 has Best planning, Balanced execution and Cheap summaries; finish Best synthesis and bounded stages in M14.1 |
| CH-14 visible tools/steps | M6/M9/M10; preserve and extend to new runs |
| CH-19 Chat/Code areas and handoff | M10, including F4 and fresh live handover; complete |
| PM-04 P2 decisions/artifact meaning retrieval | Typed decisions/memory in M5; artifact extension and scoped context tools in M17.1 |
| FK-07 knowledge folder updates | M8.11; complete under desktop/watch and web replacement boundary |
| FK-08 spreadsheet/CSV analysis | M9.6–7 and recorded/live/PC evidence; complete, preserve |
| FK-12 deep research | [M14 build](milestones/M14-deep-research.md), released owner acceptance in M19 |
| AR-07 writing canvas | M17.2 |
| AR-08 sandboxed code artifacts | M17.3, Python only under approved AG-03 boundary |
| AG-01 tool framework | M6/M9 registry; finish memory/artifact operations in M17.1 |
| AG-02 MCP | M9 generic client preserved; M15.1 native first-party transport, readers/setup in M15.2–4 |
| AG-03 execution sandbox | M8/M9, Python-only approved scope; artifact integration in M17.3 |
| AG-04 approvals/audit | M6/M8/M9/M10; preserve, shared reservations/audit M13.1 and audit completeness M18.4 |
| AG-05 plans/progress/pause/stop/caps | M6/M10; extend safe pre-dispatch caps in M13.1, research M14 and shared children M16 |
| AG-07 scheduled tasks | M10; complete, HULK-only |
| AG-10 prompt-injection guard | M9; complete, extend tests to new inputs |
| AG-11 built-in connectors | [M15 build](milestones/M15-connectors.md): native accounts, Microsoft/GitHub readers and shared setup/fixtures; released owner acceptance in M19. OneDrive/Outlook Mail/Calendar and GitHub replace Google examples |
| CA-10 structured code review | [M16.1 build](milestones/M16-coding-completion.md): pinned local/GitHub source and evidence-checked findings; released owner acceptance in M19 |
| CA-11 sandboxed commands | M8; complete, preserve |
| CA-12 skills | M16.2–3 |
| CA-14 parallel Code worktrees | M16.4–5; combined cap and review before integration |
| CA-15 HULK background/handover | M10 and fresh live acceptance; complete |
| WF-01–WF-08 Work in folders | M8/M9 recorded/live/PC evidence; complete, preserve |
| VI-01 dictation | M13.1–3 |
| CO-06, MM-12 usage CSV/reconciliation | M18.3–4, automatic supported-provider collection plus import fallback |
| CO-08 additional tool/speech costs | Existing search/run costs; duration/reservations M13.1, remaining integrations in their milestones |
| PL-04 encrypted sync | M11 automated benchmark plus separate owner-confirmed activation; complete, HULK-only |
| PL-05 offline desktop | Existing local read/drafts/housekeeping; explicit queued delivery M18.1–2 |
| SE-10 exportable activity | M9 tool activity; credential-use/policy records M13.1 and complete export M18.4 |

## Locked decisions

- Preserve HULK-only trusted sync, Python-only sandboxing, housekeeping-only local models,
  existing quality floors, permissions and the M10/M11 owner acceptance. No Node sandbox,
  additional sync backend or local-model user answers in this build.
- Dictation is cloud first using the existing OpenAI connection, explicit audio consent,
  native desktop/browser capture, two-minute/20 MiB clips and editable text without auto-send.
  Raw audio stays transient. `cpal = 0.18.2` is the only approved new direct dependency.
- Research starts in Chat, defaults to permitted HULK execution with an explicit desktop
  option, and requires a cap chosen every run with no preselected amount. Limits: 12 searches,
  24 fetched sources, 30 model calls and 30 minutes. Restricted read-only tools, cited report,
  single owner, checkpointing and explicit resume. No implicit folder/command/MCP access.
- Connectors are read-first OneDrive, Outlook Mail, Outlook Calendar and GitHub. Personal and
  work/school Microsoft accounts; owner-registered public applications; no embedded secret or
  relay. Native tokens, explicit project enablement and provider-policy checks.
- Review children before integrating their exact commits. Separate worktrees, one owner,
  three-child default maximum, one delegation level and one atomically reserved combined cap.
- Automatic provider usage reporting is explicit setup, native read-only reporting endpoints,
  separately configured permissions, and CSV fallback. Reports do not add actual-spend rows.
- New data uses forward-only migrations, existing atomic batches and explicit classifications
  in sync/deletion/backup/export. Credentials, microphone choices, grants, offline dispatch
  queues and active execution stay machine-specific. History replication never executes work.
- Reuse current IBM Plex/ledger UI and M12 Settings registry. No separate router, context
  assembler, ledger, sandbox or parallel permission system.

## Optional backlog and exclusions

P2 Nice items not required: optional localhost model adapters (MM-10), local-answer fallback
(RT-15, needs a separate quality-floor decision), custom assistants (CH-18), OCR (FK-09),
hooks (CA-13), additional remote-control/web-push behavior (CA-16), general deep links (PL-09)
and measurement-justified local/cache extensions (LL-10). Exact-match caching (RT-13) is
already delivered by M7. Usage reconciliation (MM-12) is included as the CO-06 dependency.

P3 stays out: TTS, realtime voice, image generation/editing, browser/computer automation,
general parallel research/agent steps (AG-09, beyond scoped CA-14), sharing, mobile apps,
public accounts/billing, marketplace plugins and IDE/CLI integration. Connector writes,
extra sync backends, Node and local transcription are deferred explicitly.

## Verification and closure

Every PR: `pnpm check`, relevant Rust checks, native startup and reviewed screenshot, web
verification, all five current-head CI gates. Docs-only may skip startup/screenshots with a
stated reason. Keep existing HULK and sync benchmarks. New tests use recorded/synthetic
fixtures and in-memory secrets, never real provider calls. Cover privacy, ambiguous billing,
crash/reordered delivery, stop/caps, malicious content, permission boundaries and Windows.
Add browser coverage for Chrome/Edge, Firefox and Safari/WebKit; distinguish browser-engine
CI from owner-device checks. Preserve screenshots in both themes at supported sizes.

Publish normal signed releases; record actual build/source/schema identifiers and exact
update order for desktop/HULK. No automatic HULK deployment, enrollment, account authorization
or existing-permission changes. Owner performs live microphone, capped research, connector
and usage checks through the app. Never request/read keys. A skipped check stays skipped.

The unattended build may finish with owner acceptance pending. **P2 closes only after the
owner-operated dictation, research, connector and usage checks are recorded against released
builds.** Finish with merged PRs, release/build IDs, screenshots, benchmarks, update/setup
instructions and the remaining acceptance checklist. M19 records the final evidence.

## Delivery evidence

- M12 Settings: [PR #286](https://github.com/isaacholt-hash/fuse/pull/286), release
  [v0.1.211](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.211); current-head CI and release verified.
- Roadmap: [PR #287](https://github.com/isaacholt-hash/fuse/pull/287), release
  [v0.1.212](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.212).
- M13 accounting: [PR #288](https://github.com/isaacholt-hash/fuse/pull/288), release
  [v0.1.213](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.213).
- M13 capture/transport: [PR #290](https://github.com/isaacholt-hash/fuse/pull/290), all five gates
  green before merge; released as [v0.1.214](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.214). M13 controls shipped in the step-3 PR below; [the milestone](milestones/M13-dictation.md)
  records exact checks/screenshots and [dictation setup](dictation.md) keeps real acceptance pending.

- M13 controls: [PR #291](https://github.com/isaacholt-hash/fuse/pull/291),
  [v0.1.215](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.215), source
  `cdb68ea95e567c133a1ba93039d72fa2ce39aa44`. Five CI gates and signed release publication
  verified; native, Windows and browser fixtures passed. Owner microphone/provider acceptance
  remains pending, as recorded in [M13](milestones/M13-dictation.md).

- M14 routing/search interfaces: [PR #294](https://github.com/isaacholt-hash/fuse/pull/294),
  [v0.1.216](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.216), source
  `5bd1070aa94f8f76f590967fac86522b8f3bd286`. All five current-head gates passed in
  [CI 41973164393](https://github.com/isaacholt-hash/fuse/actions/runs/41973164393);
  [release 41974374835](https://github.com/isaacholt-hash/fuse/actions/runs/41974374835)
  published signed Linux/Windows installers and seven updater entries on 2026-11-05 at
  05:38:49 UTC. Research engine and Chat entry follow in their own numbered steps.
- **M14.2:** [PR #295](https://github.com/isaacholt-hash/fuse/pull/295), merge
  `2c402488c2ee4502843e625141e293dbc0b98702`. Restricted execution, owner-local checkpoints,
  explicit context, bounded public reads, validated cited/versioned reports and atomic
  global/project/run budget holds. All five current-head gates passed in
  [CI 41980895113](https://github.com/isaacholt-hash/fuse/actions/runs/41980895113).
  Released [v0.1.217](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.217) through
  [run 41981930551](https://github.com/isaacholt-hash/fuse/actions/runs/41981930551) at
  2026-11-05 06:49:51 UTC. Installers and seven signed updater entries verified. The milestone
  records 1,074 passing tests, Rust checks, reviewed screenshots, preserved HULK benchmark
  and 16-scenario sync evidence. Live deployment/provider research acceptance remains pending.

## Roadmap verification

The roadmap PR also corrects an existing memory-test assertion: a random record UUID can
contain the four digits of a rejected PIN, so the secret check examines saved content fields
instead of serialized identifiers. No product behavior changes.

Native startup reviewed with [this screenshot](screenshots/p2/roadmap-native.png), using the
scripted build and a throwaway database/keyring. The 9.9.9 updater banner is test-fixture data,
not the released application version. `VITEST_MAX_WORKERS=2 pnpm check` passed (164 files, 971 tests, 13 skipped), as did `pnpm build:web` and all nine Chromium web click-through tests against a fresh throwaway server with in-memory test secrets. No Rust source changed; native startup rebuilt successfully. Windows and benchmark results are gated by CI in the PR.
- **M14.3:** [PR #296](https://github.com/isaacholt-hash/fuse/pull/296), merge
  `cfad7ce6f38007f7e91bce186f7eb7adbcf02643`. Chat scope/context/location setup, empty required
  cap, independent HULK ownership, progress and explicit continuation. All five gates passed
  on `70a93ff8c74fb581344828abbe0c05ca26547464` in
  [CI 41991596703](https://github.com/isaacholt-hash/fuse/actions/runs/41991596703).
  Released [v0.1.218](https://github.com/isaacholt-hash/fuse/releases/tag/v0.1.218) through
  [run 41992578860](https://github.com/isaacholt-hash/fuse/actions/runs/41992578860) at
  2026-11-05 08:20:44 UTC. Installers/seven signed updater entries verified. The final research
  benchmark and recovery assertions ship in M14.4; live owner acceptance remains M19 work.
