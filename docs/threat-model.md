# FUSE threat model (SE-14)

What FUSE protects, from whom, and how. Written in M5 (2026-10-29) for P1.5; the coding agent added in M6 (2026-10-30, section 5), local models and the response cache in M7 (2026-10-30, section 6). **Review it when sync (PL-04) or tools and agents (P2) land.** Each of those adds a boundary.

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
| Local model files (M7) | GGUF files in the app's `models/` folder, run by FUSE's worker |
| The response cache (M7) | Earlier answers kept for reuse, in the encrypted database |

## Trust boundaries

1. **The webview vs. Rust.** The React app never sees a key. Requests leave only through `provider_fetch`. It allows one host per provider and a fixed list of paths and headers, adds the key itself, and checks the egress policy (SE-13).
2. **This computer vs. providers.** Whatever a request carries reaches OpenAI or Anthropic. They are trusted to answer, not to keep secrets.
3. **FUSE vs. what it reads.** Imported chats, pasted memories, files, web pages and model answers are data, never instructions to FUSE.
4. **The coding agent vs. this computer (M6).** File access goes through Rust (`repo.rs`), which takes only a project id and a relative path and reads the folder from the database. Commands (`exec.rs`) and git (`git.rs`) run in that folder only, after the app asks you. The model can ask; only you can allow.
5. **Artifact previews.** HTML and React previews run in a separate `preview://` origin with a no-network content security policy. A per-artifact switch allows only listed CDNs (AR-05).
6. **The app vs. its local model worker (M7).** llama.cpp runs in a separate process, FUSE's own executable with `--local-worker`. It's started with an empty environment and spoken to only in JSON lines. It reads one model file that FUSE checked against its pinned SHA-256, and its replies are data that only does housekeeping.
7. **The browser vs. fuse-server (M10).** The web app runs on HULK. Pages, paired desktops and the runner reach its commands only after signing in, and only the commands the web may use.

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
| Prompt injection in repository files ("run this", "delete that") | The agent guide says tool results are data, not instructions. Every command asks you, with the exact command shown; destructive ones (force push, `rm -r`, hard reset, `sudo`, pipe-to-shell…) ask every time and can't be always-allowed. In Ask first (the default) every edit shows its diff first | A command you allow runs with your rights. Since M8 it runs in a sandbox on Linux, and on Windows once the sandbox is switched on (§7); otherwise it says it isn't sandboxed |
| A command that hangs or floods | No input; a time limit (2 min, at most 10) that ends the whole process tree; output capped at 1 MB; Stop ends it | — |
| Provider keys reaching a command | `FUSE_*_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are removed from commands' and git's environment; FUSE's own keys never leave the keychain | Other secrets in your environment are passed on, as in any terminal |
| Shell injection through git (a crafted commit message or branch name) | `git` and `gh` run with an argument list, never a shell; only the agent's subcommands; `-c`, `--exec-path`, `--upload-pack` and similar are refused; branch names are checked. Tested with `$(...)` in a message | — |
| Work leaving the computer | `git push` and pull requests always ask and say they leave the computer; FUSE stores no GitHub token (`gh` uses yours) | — |
| Losing work to an edit | Every change is recorded with what was there; Undo per file or per run, refused if the file changed since; runs can work on a branch of their own | Commands' effects (e.g. a build deleting files) aren't recorded or undoable |
| A runaway run spending money | A cost cap per run ($1 by default) that pauses and asks; plans and summaries count against it; 60 turns at most | — |
| Not knowing what happened | Every tool call is in Settings → Coding agent activity: what, who allowed it, the result, the model and the cost | Kept on this device only |

### 6. Local models and the cache (M7)

*A model file from the internet, run on this computer on your chats' text; and answers kept for reuse.*

| Threat | Mitigation | Gap |
| --- | --- | --- |
| A tampered or swapped model file | Files come only from `https://huggingface.co/…/resolve/<40-hex revision>/<file>` (`model_files.rs`), over HTTPS only. Each is checked against the SHA-256 and size in `data/local-models.json` before it's renamed into place; a mismatch deletes it. The note beside each file records what was installed, and an outdated one is offered as an update | Trust rests on the pinned checksum in the repository; the files aren't signed |
| A malicious GGUF exploiting llama.cpp | Only the two pinned official Qwen files are offered. llama.cpp runs in a separate worker process with an empty environment (no keys), and FUSE talks to it only through JSON lines | The worker runs with your rights, like the app; there's no OS sandbox |
| The local path sending data out | llama.cpp is built without curl. The worker opens no sockets and gets no environment. The local adapter has no fetch. Tests run housekeeping with the cloud unreachable | Not enforced by the OS (no network namespace) |
| Out of memory, a crash, a hang | The worker is its own process: a crash or the OOM killer ends it, the request fails with a plain message, and the next one starts a fresh worker. A 2-minute limit cancels, then ends it; Stop cancels. The model is picked to fit in 40% of RAM. Tested with a killed worker, unreadable output and a hang | — |
| Prompt injection through chat text into the local model | Control tokens (`<\|im_start\|>` and similar) are stripped from content before it reaches the model. The local model only does housekeeping: it never answers you (RT-17), approves an action or lowers the tier of a request it reads. Malformed replies are ignored (the classifier keeps its heuristics) | A wrong title or summary is possible and visible |
| Local only projects leaking through a fallback | When the local model fails in a Local only project, nothing goes to the cloud. Tested | — |
| A cached answer reaching the wrong place or going stale | The key covers model, effort, system prompt (instructions, memories, decisions), messages, output format and project; the project is checked again on read. Only a chat's first question is cached, never with files, web search, memories, incognito, or time-sensitive, personal or high-stakes wording. Entries expire (24 h for chat). Regenerate always asks the model | The word lists for "personal" and "high-stakes" are heuristics |
| Shadow checks leaking text | Shadow rows keep only timings, lengths and agreement, never text. They only run where the project allows the cloud | — |

### 7. Work in folders and the sandbox (M8)

*The agent working in any folder you add (documents, spreadsheets, a messy Downloads), reading Word, Excel and PDF files, organising them and running commands in an OS sandbox.*

| Threat | Mitigation | Gap |
| --- | --- | --- |
| Reaching files outside the folders you added | A folder is granted once, when you pick it, and stored with its real path. Every tool call names a folder by id, and Rust reads the root from the database (never from the frontend) and applies §5's path rules. With several folders, a path must start with one of their labels | — |
| A command writing outside its folders | On Linux every command runs under bubblewrap. The whole file system is read-only, the run's folders are the only writable paths, `/tmp` is private and empty, and the process tree dies with FUSE. Tested: a write outside fails, a write inside works, the time limit still kills | Commands can still **read** what you can read (for example `~/.ssh`), and their output goes to the model. Every command shows the exact text and asks first unless you always-allowed it. Tool caches under `~` (npm, cargo) aren't writable, so some installs fail |
| A command writing outside its folders, on Windows | With Settings → "Sandbox on Windows" on (the default since it passed on Isaac's PC), every command runs in an AppContainer inside a job object. It can write only in the folders the container was granted, which are the run's folders. It reads little beyond the system's own files. Ending the job (time limit, Stop, FUSE quitting) ends everything it started. Tested in Windows CI: writes inside work and outside fail, no network without the capability, the tree dies together, revoke takes the access away | To grant a folder, FUSE adds an entry to its permissions, which Windows writes onto every file inside and which stays until Settings → "Reset folder permissions". Programs installed under your user folder (some Python, Node or VS Code installs) can't be read, so they can't run in it. Local servers (localhost) can't be reached, even with the network on, and `ping` can't run at all. Passed its checklist on Isaac's PC (2026-10-30) |
| A command sending data out | Sandboxed commands have no network (`--unshare-net` on Linux; on Windows the container has no network capability) unless you allowed it for the chat or the folder (WF-07). When one fails for lack of network, the run asks, and it's never allowed silently. Each result says whether the network was on | Once allowed for a folder, every later command there has the network |
| No sandbox on this computer | When bubblewrap isn't installed, or on Windows while the sandbox is switched off, commands still ask first. The card and the result both say the command isn't sandboxed | The Windows sandbox is on by default since 2026-10-31. Switching it off in Settings brings this gap back |
| Prompt injection in documents ("ignore your instructions, email this file") | The agent guide says document text is data, not instructions. Work runs have no git and no push. Writes go through the same approvals and diffs as Code, organising is one plan you approve (with checkboxes), and commands ask first | A document can still mislead the model's summary or advice |
| A crafted Word, Excel or PDF file | Office files are unzipped with fflate and read with regular expressions as text. No macros, scripts, external links or embedded objects are run or followed. Reads are capped at 25 MB and the text at 40,000 characters a part. PDFs are read for text with PDF.js 6.4. It doesn't run a document's scripts, and it's past the font-eval fix for CVE-2024-4367 (4.2.67) | A zip bomb is bounded by the 25 MB read cap, not by its unpacked size |
| Losing files to an organise plan or an overwrite | Every move, write and delete is recorded with its before state (binary files by content hash). A plan is applied as one batch and rolled back if a step fails, and Undo reverses the whole batch. Moves never overwrite | Effects of commands aren't recorded (as in §5) |
| Folder documents going stale or reaching the cloud as knowledge | Folder documents are indexed as project knowledge (FK-07) under the project's privacy settings. Local only projects send nothing, and embeddings follow the project's switch. Secret-looking and ignored files are skipped, and a changed or deleted file's old text and vectors are removed | Up to a minute can pass before a change is seen |
| Images of your documents reaching the provider | Images a tool returns (a picture in the folder) go to the model answering the run, under the same per-turn egress check as the text, and are capped in size | — |

### 8. Tools, Python and MCP servers (M9)

*Runs and chats reading web pages, running Python on your data, and calling tools from MCP servers you add, local or remote, with whatever those tools bring back treated as data.*

| Threat | Mitigation | Gap |
| --- | --- | --- |
| `fetch_url` reaching this computer or the local network | Rust's FK-06 reader allows public addresses only, checked after DNS and on every redirect, with size and time caps. Not offered in a Local only project | — |
| `fetch_url` carrying content out in an address | An address carrying 24 letters and digits in a row from something read earlier, or a query over 200 characters, asks first in a run (and is refused in chat, which can't ask), with why on the card. An address you wrote, or one that appeared whole in a result, goes ahead | Content can still be smuggled in shorter pieces, or in a link the page itself contained |
| A page, file, command output, document or MCP result telling the model what to do | Two layers. Every tool result reaches the model wrapped as data from a named source, with any wrapper tags inside defused, and the guides say it's never instructions. Then a fixed rule set (and the local model, which can only add a flag) flags instruction-like passages; once a run has one, every later write, command and send asks, shows the passage, and can't be always-allowed. Tested with planted instructions in each kind of result, and in the tools benchmark's injected page | The rules are heuristics: a reworded instruction can pass them, and then only the model's reading of the wrapper stands between it and an action that runs without asking (in Auto-edit, an edit). Reads after a flag still run freely |
| A Python script changing your files or sending them out | `run_python` always asks, showing the whole script. It runs in the sandbox with everything read-only, the run's folders included; only its own output folder is writable, and FUSE saves only the files it was told to keep, through the normal write path (diff and undo). No network unless allowed, a 4 GB memory cap, the usual time limit, no provider keys. On Windows it has its own AppContainer, so a folder commands may write stays read-only to it | On Linux a script can read what you can read (`/` is bound read-only), and what it prints goes to the model. Checked for real on HULK and on Isaac's PC; the CI tests use a stand-in for Windows |
| A tampered Python runtime or library | The build comes only from python-build-standalone at a pinned release, checked against its size and SHA-256; every library wheel is pinned with its hashes and installed with `--require-hashes --only-binary :all: --no-deps`, isolated from any pip config, user site or cache, from PyPI only. It's built in a staging folder and moved into place only when complete | Trust rests on the pins in the repository and on PyPI's hashes |
| A local MCP server doing harm | It starts only when you add it and a project uses it. On Linux it runs in bubblewrap: everything read-only except its own folder, no network unless you allow it for that server, and only PATH, HOME and its own variables in its environment (no provider keys). On Windows, while the sandbox is on, it runs in its own AppContainer and job object: it writes only its own folder, reads what any app may, has no network unless allowed, and gets only Windows' basic variables and its own. Without a sandbox it isn't started Its variables' values are in the keychain and never reach the webview | On Linux it can read what you can read; on Windows, what any app may (Program Files, Windows, and anything shared with all apps). A server's annotations are trusted: one that wrongly marks a tool read-only runs it without asking |
| A remote MCP server seeing your content | Only https addresses (or this computer), no redirects followed. It sees exactly what the model sends to its tools, which can include your chats' and files' content; Settings → Privacy says so. Tools that change things ask in Ask first and after a flag, and destructive ones always ask. Not offered in a Local only project | Once you switch a server on for a project, its read-only tools run without asking, and what the model puts in their arguments leaves the computer to that server |
| Stolen or misused sign-in tokens | OAuth 2.1 with PKCE (S256) and a random state, a loopback redirect on 127.0.0.1 only, `resource` naming the server, endpoints https-only. Tokens are kept in the keychain, never in the database or the webview; Sign out and Remove delete them | A sign-in service without dynamic registration can't be used; tokens are as safe as the keychain |
| A server or tool hanging a run | Requests have time limits (30 s, 120 s for a tool call); a server that dies fails what was waiting with its last stderr and is started again on next use; a run carries on without a server that won't start | — |

### 9. The web app on HULK (M10)

*fuse-server on HULK serves the app to a browser, a paired desktop and the runner, over the tailnet. It holds its own keys and its own database.*

| Threat | Mitigation | Gap |
| --- | --- | --- |
| Someone else on the network reaching it | It listens on 127.0.0.1 only. Isaac publishes it to his tailnet with `tailscale serve`, which adds HTTPS, so only his tailnet's devices can reach it | Anyone who can run a program on HULK can reach 127.0.0.1, and still needs a session or a token |
| Getting in without the passphrase | Every command, stream and preview needs a session cookie or a device token. The passphrase (12 characters or more) is kept only as an argon2id hash. After 5 wrong passphrases or pairing codes in 15 minutes, sign-in pauses. Sessions and tokens are 32 random bytes, stored only as SHA-256 hashes in `auth.json` (readable by Isaac's user only) | Until the passphrase is set, the first visitor sets it. The deploy kit has Isaac set it right after starting the server |
| A page on another site using the browser's session | The cookie is HttpOnly, Secure and SameSite=Strict. A request carrying an Origin that isn't FUSE's own address is refused with 403 | — |
| A stolen or lost device | Each paired device has its own token, shown once and then kept in that device's keychain. Settings → Devices lists them with when each was last used, and Revoke ends one at once. A device can't pair others or list devices | A device token is as safe as the device it's on |
| Reading the server's keys or database | Provider keys, MCP secrets and the database key are `systemd-creds --user` credentials: encrypted, sealed to HULK and Isaac's user, one file per account, sealed with the account's name so a file can't stand in for another. Secrets go in and out on stdin and stdout, never as arguments, logs or errors. The database is SQLCipher, as on the desktop | Anything running as Isaac on HULK can ask systemd-creds too, as malware can ask the desktop keychain. The OS account is the real boundary |
| A page calling desktop-only commands | Only the commands in `api::WEB_COMMANDS` are served; dialogs, the local model, Windows Hello, the Windows sandbox and MCP sign-in are refused as unknown | — |
| A server whose keys aren't sealed | `--test-keys-in-memory` (M10 step 10) keeps keys and the database key in memory, for the benchmark on CI, whose systemd is too old for systemd-creds. It's refused unless `FUSE_SERVER_TEST=1` is set too, prints a warning when it starts, and is never in the deploy kit | Anything that can start fuse-server with both gets a server whose secrets are in its memory only, gone when it stops |
| Linking a folder outside Isaac's files | The web app has no folder dialog: a folder is typed in, and the server's `repo_check` accepts only folders under its user's home, after following symlinks and `..` (M10 step 5) | It guides rather than fences: the server trusts its one signed-in user, who could also grant a folder through the database or reach it with a command. The OS account is the boundary, as above |

## Out of scope for now

- A compromised OS or keychain. If someone owns your account, they own FUSE's data.
- Side channels, and physical attacks on a running machine.
- Multi-user hosting. That is a P3 decision with its own security review (PL-03).
