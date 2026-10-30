# FUSE threat model (SE-14)

What FUSE protects, from whom, and how. Written in M5 (2026-10-29) for P1.5; the coding agent added in M6 (2026-10-30, section 5). **Review it when sync (PL-04), tools and agents (P2), or local models (M7) land.** Each of those adds a boundary.

## What's worth protecting

| Asset | Where it lives |
| --- | --- |
| API keys (OpenAI, Anthropic) | OS keychain (Linux Secret Service, Windows Credential Manager), read only by the Rust transport |
| Chats, memories, decisions, tasks, projects, artifacts, usage | `fuse.db`, SQLite encrypted with SQLCipher; the 256-bit key is in the OS keychain |
| Attached and knowledge files | `files/<sha256>` in the app data folder (not encrypted at rest; see below) |
| Backups | `backups/*.db`, copies of the encrypted database (PL-11) |
| Exports | Zips you save; plain JSON and files (SE-07, PL-12) |
| Linked repositories (M6) | Folders on this computer the coding agent may read, change and run commands in |
| This computer itself (M6) | Commands a coding run runs execute as you, with your rights |

## Trust boundaries

1. **The webview vs. Rust.** The React app never sees a key. Requests leave only through `provider_fetch`. It allows one host per provider and a fixed list of paths and headers, adds the key itself, and checks the egress policy (SE-13).
2. **This computer vs. providers.** Whatever a request carries reaches OpenAI or Anthropic. They are trusted to answer, not to keep secrets.
3. **FUSE vs. what it reads.** Imported chats, pasted memories, files, web pages and model answers are data, never instructions to FUSE.
4. **The coding agent vs. this computer (M6).** File access goes through Rust (`repo.rs`), which takes only a project id and a relative path and reads the folder from the database. Commands (`exec.rs`) and git (`git.rs`) run in that folder only, after the app asks you. The model can ask; only you can allow.
5. **Artifact previews.** HTML and React previews run in a separate `preview://` origin with a no-network content security policy. A per-artifact switch allows only listed CDNs (AR-05).

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
| A model answer that tries to exfiltrate | In chat, no tools that act or fetch on a model's say-so; web search is the provider's own tool. Coding runs can run commands, which could send data anywhere; each one asks you (section 5). **Revisit when general tools and agents land (P2)** |
| A coding run sending repository content to a blocked provider | Every send path of a run (its turns, the plan, summaries) carries the project's scope, so the Rust transport checks it; the run also checks the policy before each turn and refuses with the reason. A Local only project runs no cloud step. The planner and summarizer are skipped when their provider is blocked (M6 step 12) |
| A key used outside FUSE's limits | Spend caps per key in FUSE (MM-09), and hard limits in the provider consoles (CO-07) |

### 5. The coding agent (M6)

*A model that reads your repository, changes files and runs commands, steered by your request and by whatever the repository says.*

| Threat | Mitigation | Gap |
| --- | --- | --- |
| Reaching files outside the repository (`../`, absolute paths, symlinks) | Rust resolves every path against the root from the database: relative only, no `..`, and the real path (after symlinks) must be inside the root; writes check the deepest existing folder the same way. Tested per rule (CA-01, CA-02) | — |
| Changing `.git` or committing secrets | `.git` is never read or written; `.env`, keys and similar are refused unless the project allows them; ignored files aren't read | Secrets in ordinary-looking files are not detected |
| Prompt injection in repository files ("run this", "delete that") | The agent guide says tool results are data, not instructions. Every command asks you, with the exact command shown; destructive ones (force push, `rm -r`, hard reset, `sudo`, pipe-to-shell…) ask every time and can't be always-allowed. In Ask first (the default) every edit shows its diff first | A command you allow runs with your rights; there is no sandbox yet (CA-11, P2) |
| A command that hangs or floods | No input; a time limit (2 min, at most 10) that ends the whole process tree; output capped at 1 MB; Stop ends it | — |
| Provider keys reaching a command | `FUSE_*_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are removed from commands' and git's environment; FUSE's own keys never leave the keychain | Other secrets in your environment are passed on, as in any terminal |
| Shell injection through git (a crafted commit message or branch name) | `git` and `gh` run with an argument list, never a shell; only the agent's subcommands; `-c`, `--exec-path`, `--upload-pack` and similar are refused; branch names are checked. Tested with `$(...)` in a message | — |
| Work leaving the computer | `git push` and pull requests always ask and say they leave the computer; FUSE stores no GitHub token (`gh` uses yours) | — |
| Losing work to an edit | Every change is recorded with what was there; Undo per file or per run, refused if the file changed since; runs can work on a branch of their own | Commands' effects (e.g. a build deleting files) aren't recorded or undoable |
| A runaway run spending money | A cost cap per run ($1 by default) that pauses and asks; plans and summaries count against it; 60 turns at most | — |
| Not knowing what happened | Every tool call is in Settings → Coding agent activity: what, who allowed it, the result, the model and the cost | Kept on this device only |

## Out of scope for now

- A compromised OS or keychain. If someone owns your account, they own FUSE's data.
- Side channels, and physical attacks on a running machine.
- Multi-user hosting. That is a P3 decision with its own security review (PL-03).
