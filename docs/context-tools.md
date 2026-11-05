# Memory and artifact tools

Chat, Code and Work share the same six app-managed context tools. Projects can switch each
one off in Settings; every call rechecks the current conversation, project, provider policy
and execution owner. Research keeps its separate, restricted selection and tool set.

`read_memory` returns active, unexpired memories with their revision, scope, authority and
source. Unresolved sync conflicts, private source chats, records kept on the device and
out-of-scope memories are excluded. Turning memory off disables these reads and suggestions.
`propose_memory` adds an inert suggestion to the existing Memory review screen. New records
stay in their originating conversation. Updates and deletions require the current revision;
model tools cannot change global memories or decisions. Review shows the model and source.
Owner approval is atomic, retains the previous record as history for updates, and preserves
scope, authority, sensitivity and provider-send restrictions. A changed target must be reviewed
again. No model suggestion activates itself or silently becomes an owner-authored decision.

`create_artifact` creates a saved app artifact and first version. `update_artifact` requires
the exact current version UUID and retains the previous version. Concurrent or stale edits,
deleted artifacts and duplicate keys are refused. Receipts make repeated mutation calls
idempotent. These tools neither edit repository files nor execute content or grant access.
Tool-created artifacts open in the existing panel and remain available from their Chat card.
The normal editor and version picker still work; reviewed section revisions follow in M17.2.

`search_artifacts` searches only the current conversation or its project. Keyword search
works without an embedding connection. Meaning search uses the allowed catalog embedding
model, reserves its full per-input token allowance before one dispatch and records the actual
receipt in Usage and includes Chat retrieval charges in the answer/thread total without
adding another actual-spend receipt. Context reads and mutations are not response-cached. Code child requests share their parent's combined cap. Missing usage or a
lost response remains visibly unresolved, with its hold retained; the same tool turn never
retries a paid embedding request. Keyword fallback explains unavailable, refused or interrupted
meaning retrieval. Clearing embeddings in Storage also clears this derived index.

Search is bounded: up to 200 recent eligible artifacts, with meaning ranking over the title
and up to the first 4,000 UTF-8 bytes of 16 recent artifacts. Files over 100,000 characters
are outside the context-tool limit. Results disclose coverage and fallback, and include the
artifact/version UUID, source conversation, source message, author category and excerpt.
`read_artifact` reads the pinned current UUID in 12,000-character pages. Results are wrapped
as untrusted data; embedded instructions confer no authority. Possible secrets are excluded.
These limits do not claim exhaustive semantic recall of arbitrarily large libraries.

The shared Chat assembler recalls up to three short relevant artifact excerpts, alongside
existing memory and edited-artifact context, with source IDs recorded in its context parts.
It respects memory-off and never adds automatic context to an explicitly selected Research
request. Mere sync receipt never makes an embedding call or starts execution.

Privacy and source versions are checked before and after asynchronous retrieval. Withdrawal,
source moves and policy changes invalidate derived vectors. Schema 73 adds owner-local
proposal provenance, derived `artifact_vectors` and content-free `context_tool_audit` receipts.
They confer no portable execution authority. Vectors and receipts are excluded from sync and
portable content exports; existing explicit owner exports retain memory suggestions. Global
deletion and source foreign keys remove local records. Encrypted full-database backups can
retain inert records under the separate backup retention policy; restoring one never replays
a tool. Redacted audit metadata is available for the completed activity export in M18.

Recorded checks use synthetic replies and in-memory test secrets. Run the shared scope,
accounting and merge regressions with `pnpm exec vitest run src/context src/cost/embedding.test.ts`.
For the real native-storage browser fixture, build `fuse-server` with `--features server`, set
`FUSE_WEB_BROWSER` to a Chromium executable and run `bash scripts/context-web.sh`. The fixture
creates its own temporary home and verifies schema 73, review, versioning and source UUIDs.
It never uses the running installation, a provider key or a production account.
