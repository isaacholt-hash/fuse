# FUSE threat model (SE-14)

What FUSE protects, from whom, and how. Written in M5 (2026-10-29) for P1.5. **Review it when sync (PL-04), the coding agent (M6), tools and agents (P2), or local models (M7) land.** Each of those adds a boundary.

## What's worth protecting

| Asset | Where it lives |
| --- | --- |
| API keys (OpenAI, Anthropic) | OS keychain (Linux Secret Service, Windows Credential Manager), read only by the Rust transport |
| Chats, memories, decisions, tasks, projects, artifacts, usage | `fuse.db`, SQLite encrypted with SQLCipher; the 256-bit key is in the OS keychain |
| Attached and knowledge files | `files/<sha256>` in the app data folder (not encrypted at rest; see below) |
| Backups | `backups/*.db`, copies of the encrypted database (PL-11) |
| Exports | Zips you save; plain JSON and files (SE-07, PL-12) |

## Trust boundaries

1. **The webview vs. Rust.** The React app never sees a key. Requests leave only through `provider_fetch`. It allows one host per provider and a fixed list of paths and headers, adds the key itself, and checks the egress policy (SE-13).
2. **This computer vs. providers.** Whatever a request carries reaches OpenAI or Anthropic. They are trusted to answer, not to keep secrets.
3. **FUSE vs. what it reads.** Imported chats, pasted memories, files, web pages and model answers are data, never instructions to FUSE.
4. **Artifact previews.** HTML and React previews run in a separate `preview://` origin with a no-network content security policy. A per-artifact switch allows only listed CDNs (AR-05).

## Threats and mitigations

### 1. Local compromise

*Someone or something on this computer: malware running as you, a stolen or shared laptop, an unlocked session.*

| Threat | Mitigation | Gap |
| --- | --- | --- |
| Reading the database file | SQLCipher encryption; key in the OS keychain, never on disk in the clear (M1 C2) | Malware running as you can ask the keychain too. The OS account is the real boundary |
| Reading keys | Keychain only; never logged, printed, exported or sent to the webview; tests use recorded fixtures | Same as above |
| Someone at an unlocked app | App lock with passcode or Windows Hello (SE-03) | Off by default |
| Reading attachments | Files are named by hash in the app data folder | **Files aren't encrypted at rest.** Candidate for P2 |
| Reading backups | Backups are copies of the encrypted database; a plaintext backup is refused (PL-11) | Backups sit beside the database, so they are not protection against losing the disk |
| Tampered attachments | Settings → Your data → Check attached files re-hashes every file against the database | Detects, doesn't prevent |

### 2. Sync compromise (P2, not built)

*Whoever controls the storage a future sync uses: a cloud bucket, a file-sync folder, a server.*

Nothing syncs today. When PL-04 is built:

- **Encrypt end to end on the device.** The storage only ever sees ciphertext.
- **Sync logical records**, with `revision` and `device_id` (already on memories since M5), never the database file.
- **Authenticate every record**, so tampering is detected rather than merged.
- **Send competing edits to decisions or facts to review.**
- **Define device revocation and lost-key behaviour.**
- **Keep sync separate from backup.** A deletion that syncs must not destroy the only copy.

### 3. Malicious imports

*A crafted ChatGPT or Claude export, a pasted memory list, a FUSE export from someone else, a hostile file or web page.*

| Threat | Mitigation |
| --- | --- |
| Oversized or deeply nested files that exhaust memory | A size cap on attachments (50 MB, in Rust). A FUSE export is validated, with size limits, before anything is written (PL-12, M5 step 12) |
| Paths in archives (`../`) | Files are stored only by their SHA-256. Restoring an export uses the hash, never a name from the archive, as the path (M5 step 12) |
| Prompt injection in imported content ("ignore your instructions…") | Imported text is history or a suggestion, never a system instruction. Pasted memories go through review (PM-08); extracted ones never become decisions (PM-15) and never override yours |
| Secrets inside imports | Pasted memories and suggestions are screened for keys, passwords, card and ID numbers (PM-05); files are screened before sending (FK-11) |
| Duplicate or colliding ids on restore | Restore keeps ids and skips records already present; it never overwrites (PL-12) |
| Hostile HTML or React in an artifact | Sandboxed preview origin, no network by default (AR-05) |

### 4. Provider exposure

*What reaches OpenAI or Anthropic, and what happens to it there.*

| Threat | Mitigation |
| --- | --- |
| Sending more than needed | One context assembler builds every request from parts in scope, each with its source (PM-18); memories are ranked within a budget (PM-04) |
| Sending a project's content to a provider you blocked | Egress policy per project and per record, checked in the app and again in the Rust transport from the database. A content-carrying request without a scope is refused (SE-13, M5 steps 8–9) |
| Sensitive records leaving the device | A memory or knowledge file can be kept on this computer (`may_send = 0`); Local only projects send nothing |
| Housekeeping leaks (titles, summaries, suggestions, embeddings) | The same policy applies to every housekeeping call and to embeddings; a project can turn embeddings off |
| Provider retention | OpenAI requests set `store: false`. Anthropic and OpenAI keep data under their own API terms, outside FUSE's control. Settings → Privacy says what is sent (SE-15) |
| A model answer that tries to exfiltrate | No tools that act or fetch on a model's say-so in P1; web search is the provider's own tool. **Revisit when tools and agents land (P2)** |
| A key used outside FUSE's limits | Spend caps per key in FUSE (MM-09), and hard limits in the provider consoles (CO-07) |

## Out of scope for now

- A compromised OS or keychain. If someone owns your account, they own FUSE's data.
- Side channels, and physical attacks on a running machine.
- Multi-user hosting. That is a P3 decision with its own security review (PL-03).
