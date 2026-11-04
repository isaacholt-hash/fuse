# M11 encrypted sync benchmark

Recorded on 2026-11-04 on Linux, using the native debug build. The machine-readable
[result](M11-sync.json) contains the measured timings and assertions. Run `pnpm sync:bench`
to produce a fresh `src-tauri/target/sync-benchmark.json`; CI uploads it as
`encrypted-sync-benchmark`.

## Participants and workload

The test creates two independent desktop-style `Ctx` instances, each with its own SQLCipher
database, file store, device identity and in-memory secret store. A third independent context
participates as HULK behind the real authenticated axum HTTP server on an ephemeral loopback
port. Pairing and native enrollment use the production client/transport code. No production
directory, real provider key or runner is used. All fixture stores are removed on success.

Each desktop begins populated before enrollment. The initial union contains sixteen messages,
two conversations, typed memory, overlapping settings/tags, three deduplicated cost requests,
a completed run and a **2,097,169-byte** app-managed attachment in **three encrypted chunks**.
The three synthetic cost requests total **123,490 integer micro-dollars** with unchanged
original desktop/web/runner attribution. Those are historical fixture amounts, not API spending.

The worker is driven explicitly to quiescence, using its real push/pull, causal merge, encrypted
chunk, cursor, acknowledgement and cleanup paths. The recorded run's initial union took
6.978 seconds and the full scenario 18.635 seconds. These are local debug protocol timings;
they do not include the background debounce/poll waits and are not a WAN or production latency
claim. CI timing varies.

## Checked end to end

- Union of populated desktop and HULK databases with stable record IDs and natural-key
  settings/tag reconciliation. Machine-specific repository paths remain different and lock
  settings never enter HULK's database.
- Full encrypted file round trip with verified bytes in each participant's local file store.
- Identical integer cost totals without duplicate request IDs or rewritten surface attribution.
  Completed run snapshots arrive read-only and no execution queue is created.
- Offline edits converge despite skewed record timestamps. Concurrent facts enter review on
  all participants, and one explicit resolution converges everywhere.
- Re-delivery after a committed cursor simulates a lost acknowledgement without duplicate costs.
- Undo before the deadline, final deletion against an offline edit, preserved content-free cost
  totals, and file bytes retained through a surviving public reference.
- Workspace deletion covers an unseen offline conversation, purges public history and costs,
  retains permanent markers, and preserves bytes referenced by a separate private local file.
  Explicit new records after acknowledging the wipe converge normally.
- HTTP revocation blocks the device token. Another active offline desktop refreshes the new
  encryption epoch and commits its pending edit without losing work.

## Additional acceptance checks

| Case | Verification |
| --- | --- |
| Interrupted chunks, corrupted complete hash, atomic installation | Native attachment tests; concurrent Unicode-path file installation/repair test, also run on Windows |
| Invalid signatures, modified metadata/ciphertext, wrong workspace/key/epoch | Native crypto and authenticated transport tests |
| Validly signed active-run snapshot | Transport rejects it before staging; streaming capture is excluded |
| Reordered/missing parents and circular dependencies | Native merge staging and transactional rollback tests |
| Concurrent provider denial and rule removal | Both delivery orders preserve denial and emit a causal join |
| Concurrent deletion/privacy markers | Restrictive withdrawal and both causal barriers survive; deliberate later edits remain possible |
| Unseen offline private cost records | Ancestor withdrawal blocks them even though ordinary deletion retains costs |
| Late files after parent deletion | Rejected without a public share; unknown public parents stage rather than lose the file |
| Artifact collisions and simultaneous versions | Natural-key aliases and UUID-based version ordering tests preserve both |
| Lost keys/recovery and interrupted rotation | In-memory native recovery/management tests; no pending-edit loss, no epoch downgrade or revocation rollback |
| Incompatible versions and duplicate pages | Native HTTP/worker tests pause safely without advancing invalid cursors |
| Migration preservation and exclusions | Seeded database upgrade tests and exhaustive table/column/reference registry coverage |
| Shared UI and background refresh | Desktop light/dark and authenticated web screenshots; UI enrollment/review/recovery/revocation tests; draft-preservation test with zero provider calls |

The Linux CI job runs this benchmark without replacing the existing Runs on HULK benchmark.
Windows CI separately runs the shared native sync tests and atomic-file tests, plus the
existing Windows sandbox/clippy and click-through checks. This is compatibility evidence,
not a claim that the Linux-only HULK server runs on Windows. Live deployment, real HTTPS
certificates, production enrollment and real provider calls are outside this synthetic run.
