# Encrypted sync on HULK (M11)

M11 is being built; the controls and full activation instructions arrive with steps 7 and 8.
Installing an intermediate build or pairing with HULK does not upload desktop history.

## Trust and enrollment

HULK hosts encrypted logical records and participates in sync so the web app and runner can
use them. HULK can read the synced data. Browsers use its database; each enrolled desktop
has its own encrypted database, identity and durable outbox. The database file never syncs.

Setup first previews the portable content. The HULK setup command requires explicit confirmation;
desktop enrollment requires both pairing and a separate confirmation. The native enrollment route
requires a non-runner device bearer token. Browser cookies cannot obtain the workspace keys.
Status and preview return counts/state and public device identities, never encryption or signing
keys. Workspace keys travel only between native participants over the configured HTTPS connection
(loopback HTTP is for recorded fixtures). Redirects are refused. Both builds must have the same
schema and sync protocol before enrollment.
HULK setup and recovery commands require its signed-in browser session. Device tokens and
the internal runner cannot call them; sync responses are marked `no-store`.

Private/incognito content, local-only projects, device-kept records, machine folder/network/command
grants and credentials are excluded. An indexed folder document is not an uploaded file. A pending
file must have an eligible conversation or knowledge relationship before it can replicate. Merely
opening a synced session cannot grant local file access or execute its historical run.

## Keys and recovery

The approved native dependencies are `chacha20poly1305 = 0.11.0` and `ed25519-dalek = 3.0.0`.
They encrypt packet bodies with fresh nonces and sign authenticated metadata/ciphertext per device.
The already-bundled `zeroize` crate clears owned key material where its wrappers are used.
Metadata exposes protocol/schema, workspace/user/dataset IDs, epoch, device/event IDs, sequence,
logical clock and encrypted sizes. Names, entity contents and file hashes stay inside encryption.

Each epoch key is a separate OS secret-store entry, avoiding Windows credential-size limits.
Ordinary settings, backups/exports and replication tables contain no plaintext sync keys or provider
credentials. A separate random recovery code encrypts the recovery bundle, including the host's
signing identity and roster. Preserving the identity allows outstanding changes and historical
signatures to survive recovery. The code can be displayed only by an explicit action on HULK.

The encrypted bundle lives in the app data folder at `sync/recovery.json`; keep it with the
encrypted sync store and keep its code separately. Recovery requires signing in on HULK and
supplying the current code. It cannot substitute for the separate SQLCipher database recovery
key. Without surviving keys or the current recovery code/bundle, old ciphertext is unrecoverable.

If recovery fails while changing the key store or database, sync stays paused and pending changes
remain available; retry recovery after correcting the storage problem. A desktop refuses older or
inconsistent HULK keys rather than overwriting its surviving keys. Revocation cannot erase copies
that were already downloaded. Sync and backup remain separate.

## Native transport and worker

The desktop and HULK each run one leased worker after the database opens; tabs and chats do
not own it. SQLite triggers capture writes, including browser/runner writes on HULK. The worker
seeds eligible pre-enrollment rows, debounces changes for one second (bounded during continuous
writes), polls every five seconds, and retries network/storage failures exponentially up to sixty
seconds. Pause stops subsequent transfers; an already-sent request can finish. Sync now bypasses
the retry delay. Incompatible builds, failed authentication and malformed packets pause with the
pending outbox intact. A database lease renews during slow operations and expires after a crash.

Native authenticated `/api/sync/{keys,push,pull,ack,blob-put,blob-get}` interfaces accept typed
versioned records, never remote SQL. Browser cookies and runner tokens cannot use these routes.
Every received packet is verified before a page and its cursor commit together. Acknowledgements
follow that commit; replaying a page or a push is harmless. Reusing an event ID for different
content is refused. The relay stores signed ciphertext and opaque encrypted chunks; public
headers contain no entity names or filenames. Record application follows in step 5, file manifests
and retention in step 6, and management/revocation controls in step 7. Intermediate builds expose
no setup UI; transport acceptance alone does not mean records have been merged.
