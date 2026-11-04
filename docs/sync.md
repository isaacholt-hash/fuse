# Encrypted sync with HULK

Sync is optional and separate from pairing. HULK is a trusted participant: it can decrypt
synced content for its web app and runner. Browsers use HULK's database; they are not replicas.
No provider request or run starts because of syncing. Bucket storage and file-sync folders are deferred beyond M11.

## Enable

1. Use matching desktop and HULK builds. Sign in to HULK and open **Settings → Sync**
   (the `/#sync` link opens that section).
2. Choose **Preview & enable sync**, review the eligible records and file bytes, acknowledge
   HULK's trusted role, then choose **Enable sync and merge histories**.
3. On each desktop, pair through **Settings → HULK** first. Then open **Settings → Sync**,
   preview that desktop's eligible content, name the device and explicitly enable sync.
4. Leave the apps online while the initial union completes. Stable record IDs are preserved;
   repeated delivery does not duplicate costs or execute runs. **Sync now** requests a cycle.

Incognito history, local-only projects, records kept on this device, credentials, app-lock
information, caches and indexes are excluded. Repositories, absolute paths, installations and
folder/command/network permissions remain specific to each machine. Portable preferences
use the allowlist in `data/sync.json`. Opening received history grants no new access.

## Status and conflicts

Settings shows the last successful cycle, pending changes, verified file progress, devices,
errors and records waiting for their dependencies or execution owner. The worker runs without
an open conversation or browser tab. It debounces local changes for one second, polls every
five seconds and backs off failed connections to sixty seconds. Update both sides when versions
differ. Authentication or malformed-data failures pause transfers and preserve pending work.

Concurrent facts and decisions stay out of model context until **Review conflicts** selects
a version. Both texts, rationale, alternatives and provenance are shown. Resolution creates a
new replicated revision while preserving current privacy and scope. Ordinary losing revisions
are kept thirty days; unresolved conflicts remain until resolved.

## Pause, disable and delete

**Pause** temporarily stops transfers. **Resume** retries after the underlying issue is fixed.
**Disable sync** preserves local data and the sync identity, and stops transfers. It does not
delete other copies. Later local changes remain pending until explicit re-enrollment.

**Your data → Delete everything** explicitly propagates deletion of synced content to enrolled
replicas when they reconnect. If transfers are paused or disabled, explicitly resume/re-enable
sync to send the deletion. Conversation/message deletion keeps the existing eight-second undo
window. Permanent content-free markers prevent old devices from restoring deleted content.
Privacy withdrawal removes remote copies while retaining the source's private local copy.
Completed imported runs are read-only; active runs and schedules keep their execution owner.
Deletion waits for that owner's existing controls when necessary.

Sync deletion does not erase backups or copies already downloaded by revoked devices. Backups
retain their independent policy; sync is not a backup.

## Recovery and revocation

In HULK's signed-in **Settings → Sync**, explicitly show and securely store the separate sync
recovery code. The code and encrypted `data_dir/sync/recovery.json` bundle are both required
when the surviving sync keys are lost. HULK authentication is also required. The code alone
cannot enroll a desktop, and it does not unlock the separate SQLCipher database. Without
surviving keys or the current recovery code and bundle, encrypted sync data cannot be recovered.
Use **Recover sync** on HULK; desktop recovery/revocation controls link to that signed-in page.

Revoke a desktop in HULK's Sync device list or existing Devices list. Its bearer token is blocked
immediately, its sync membership is revoked, and encryption and recovery material rotate.
Save the new recovery code. Active offline devices receive current keys after authenticated
reconnect and re-encrypt pending transfers. Revocation cannot erase their previously downloaded
copies. An interrupted rotation keeps transfers blocked; **Finish device revocation** safely
retries it before sync can resume. Recovery cannot downgrade a completed encryption epoch or
undo a recorded revocation.

Deployment, update and benchmark instructions are completed in M11's release step. Building
the milestone does not deploy HULK, change production data or enable any existing installation.

## Protocol and storage

Encryption and signing stay in Rust: pinned `chacha20poly1305 = 0.11.0` supplies
XChaCha20-Poly1305 with fresh nonces, and `ed25519-dalek = 3.0.0` supplies strict per-device
signature verification. Owned key material uses the bundled zeroize interfaces. Each epoch key
occupies a separate secret-store entry, including on Windows. Ordinary UI replies contain
status, counts and public identities, never encryption or signing keys. Native enrollment uses
verified HTTPS, refuses redirects and requires matching schema/protocol versions. Browser
cookies and internal runner tokens cannot obtain native enrollment keys. Responses are `no-store`.

Authenticated `/api/sync/{keys,push,pull,ack,blob-put,blob-get,blob-probe,blob-release}` routes
exchange typed records. Event IDs, originating device/sequence, protocol/schema, dataset,
workspace/user, logical clock, epoch, encrypted sizes and traffic timing are visible metadata;
record contents, entity names, filenames, paths and plaintext hashes remain inside ciphertext.
HULK's participating database and local replication bookkeeping use SQLCipher. The database
file itself is never replicated.

Each installation has a durable worker lease, renewed during long operations. Inbox bodies
and their cursor commit before acknowledgement. Stable event IDs and content-free digests
make retries harmless, including after payload cleanup; reusing an ID for another body fails.
Complete dependency batches, including circular thread/message references, commit together.
Missing parents remain staged rather than silently dropped. Optional private/deleted provenance
is explicitly marked unavailable. Sync never creates a machine grant or execution queue.

Causal vectors distinguish later edits from independent offline edits. Ordinary concurrency
uses logical clock, device ID and event ID, retaining the loser. Provider rules and project
policies merge restrictively. Natural-key collisions keep durable identity aliases. Artifact
version UUIDs remain authoritative and displayed ordinals follow deterministic ordering.
Request IDs deduplicate costs while retaining integer micro-dollar amounts and original
surface attribution. Schedules retain ownership and attribution without being replicated.

App-managed files use authenticated encrypted 1 MiB chunks, resumable progress and complete-file
hash verification before atomic installation at a locally generated path. Existing limits are
50 MiB per file and 64 MiB per structured sync record. Shared references protect bytes;
abandoned incomplete uploads expire after one hour unless renewed. Names and hashes occur only
inside encrypted manifests. Repository and indexed-folder contents are not uploaded by sync.

## Update and activate desktop + HULK

M11's build does not deploy or enroll anything. To activate the verified build:

1. In the current apps, save a backup/export you want to retain and finish or stop active
   runs through their existing owner controls. Keep the database recovery key and the sync
   recovery code separate; neither is a provider credential.
2. Install the latest published FUSE desktop release on each device (Settings → Check for
   updates → Restart, or its signed installer from GitHub Releases).
3. On HULK, explicitly deploy from the verified `main`:

   ```bash
   cd /home/daywalker/fuse
   git switch main
   git pull --ff-only
   bash scripts/deploy-server.sh
   ```

   This command installs/restarts the production service; it is deliberately left for you.
   The existing deployment guide is [HULK server](hulk-server.md). The service remains bound
   to loopback behind its existing verified HTTPS tailnet route.
4. Reload HULK's web app. Desktop **Settings → HULK** shows the schema/build on both sides;
   use matching builds. Sign in at
   [HULK Settings → Sync](https://hulk.tailb7c872.ts.net:4100/#sync).
5. Enable HULK through its preview and trust choice, store the separately displayed recovery
   code safely, then pair and explicitly enroll each desktop through its own preview.
6. Wait for pending changes/files to finish and check last success, conflicts and devices.
   Resolve fact/decision reviews before expecting those records in model context. Verify a
   harmless test chat follows both ways; keep any private test in a local-only project.

Future updates follow the same desktop/HULK build matching rule. A version mismatch pauses
transfers and retains local work. Migrations are forward-only: changing the server symlink
back to an older binary does not undo a schema upgrade. Do not point an old build at a newer
database. Sync never deploys HULK or updates its service for you.

## Backup and restore boundaries

Automatic database backups keep the newest **ten** encrypted snapshots; Settings → Your data
can explicitly prune them. This policy is separate from thirty-day superseded sync revisions
and permanent M11 deletion markers. Sync deletion does not rewrite backup snapshots or your
exports. Export archives and the app-managed file store can contain plaintext file bytes;
protect them separately. A database snapshot alone is not an attachment backup.

The sync recovery bundle protects keys and device identities, not missing application data.
Recovery needs the current encrypted bundle/code, HULK authentication and access to the separate
SQLCipher database. It does not restore provider credentials or machine grants. Preserve the
current encrypted sync store and app-managed files when backing up the host.

An enrolled database includes device counters, acknowledgements and deletion barriers. Do not
clone it to create another replica or treat a historical snapshot as a rollback of the whole
sync workspace. Reusing an event ID for changed content pauses rather than overwriting accepted
history. Restore historical application content by explicit export/import into a healthy current
installation when possible; ordinary stale replicas remain subject to permanent deletion
markers. Recovering lost keys is separate from recovering a lost or rolled-back database.

## Reproduce the benchmark

```bash
pnpm sync:bench
```

This starts two independent desktop-style databases/workers and a throwaway real HTTP HULK,
using only synthetic content and in-memory test secrets. It records
`src-tauri/target/sync-benchmark.json`, then removes the participants' temporary stores. It
checks initial union, files, natural keys, costs, conflicts, offline edits, undo/deletion,
shared private bytes and revocation/rotation. The [recorded result](benchmarks/M11-sync.json)
and [coverage and limits](benchmarks/M11-sync.md) describe the evidence. CI uploads a fresh
result and runs native Windows sync/file compatibility checks alongside the existing HULK
benchmark and click-through workflows.
