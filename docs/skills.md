# Named skills

Settings → Personalization → Skills imports reusable instructions and supporting files.
Choose a `SKILL.md` file or a ZIP with `SKILL.md` at its root; a single containing folder is
accepted. Enter a lowercase name using letters, numbers and hyphens, choose Every chat or a
project, review the preview, then Import skill. Front matter remains instruction text; FUSE's
name field is authoritative. Importing makes no model request, changes no grants and runs nothing.

Limits: 2 MiB archive and total uncompressed content, 64 archive entries, 256 KiB per file,
32 KiB for `SKILL.md`. Files use portable ASCII relative paths. Absolute paths, traversal,
backslashes, alternate streams, device names, links, special files, reparse entries, private
locations, case-colliding names and file/folder collisions are refused. ZIP metadata, bounds,
CRC-32 and SHA-256 are checked. Files stay in app-managed records; import does not extract them
into a repository or installation. Binary support files remain inert.

Type `/skill name` as the first line, followed by the task. Composer suggestions and the
command palette insert `/skill name@VERSION_UUID` into the editable draft. Sending resolves a
plain name and saves that pin in the question and run task. Selecting never sends, preserves
existing draft text, and does not duplicate the same inserted command. Up to three consecutive
leading commands may be used. Quoted commands, tool results and ordinary mentions do not invoke.

Invoking sends the pinned instructions to the selected model for that request. Support files
are listed with their names, sizes and hashes; contents are supplied only by a bounded
`read_skill_file` call for the invoked version. UTF-8 reads are limited to 30,000 characters.
Results use the existing untrusted-data wrapper and injection checks. Chat gains no write or
execution tools. Code and Work keep their existing modes, folders, policies and approvals.
Code and Work may run an invoked package script only through the explicit approval below.

Packages cannot widen permissions, read credentials, override provider restrictions or bypass
approvals. App/privacy rules, custom instructions and the user's current directions take
priority. Links and paths in a package confer no filesystem, network or MCP access. Review
package instructions before importing and invoking them.

Choose an existing package in the import form to add an immutable version. Older UUIDs remain
available to existing invocations, regeneration and explicit continuation. Concurrent versions
survive. Unrelated packages sharing a name remain separate; plain-name invocation fails as
ambiguous, so select a pin. Source labels, UUIDs and hashes identify provenance, without
claiming publisher trust or instruction correctness. Deleting a package removes every version
after confirmation. Later requests using those pins stop rather than selecting a substitute.

Packages follow existing opt-in encrypted HULK sync. Local-only projects and packages marked
Exclude this package from sync stay local. Privacy withdrawal and deletion use content-free
markers and the existing dependency graph. Stale replicas cannot restore removed versions.
Execution and grants never follow synced history. HULK execution needs the exact package
version on HULK: import it there or let enrolled sync finish. Missing/altered content stops use.
Excluding from sync still allows an explicit invocation to send instructions to the chosen model.

Forward-only schema 69 adds `skills` and immutable `skill_versions`, with explicit replication,
deletion and export classification. Portable exports include packages/assets (including sync
excluded packages when explicitly exported); project exports include that project's packages.
Restore preserves IDs and never starts execution. Full encrypted database backups retain
packages under the separate backup retention policy; deletion does not rewrite older backups.
Original machine paths and permission state are absent from packages.

Recorded verification uses synthetic packages and model replies. Released owner usage and the
remaining browser engines are separate M19 acceptance work.

## Approved Python scripts

In a Code or Work run, invoke a pinned package and ask for its named `.py` script. Install
Python under Settings → Python for data work first, and enable the Windows sandbox where
applicable. Plan mode, code review, ordinary Chat and replicated history cannot execute it.
FUSE always asks before execution, showing the entire source, version UUID, script/package
SHA-256, literal arguments, supporting file names/hashes and execution limits. Deny runs
nothing. Importing, selecting, syncing or restoring a package never runs a script.

Scripts read immutable copies of their package assets and receive at most 32 arguments
(total 16 KiB). They have no project-folder mounts, credentials, network or inherited folder
permissions. A package may import its own Python modules. Use `os.environ['FUSE_OUT']` for
outputs. The model receives bounded output/files and image previews through the existing tool
result pipeline. To save generated files, provide `keep` mappings: `from` is a relative name
inside `FUSE_OUT`, and `to` is a relative destination in an already linked folder. Approval
shows each mapping. After successful execution FUSE writes only those outputs through its
existing file-write path, with a diff and undo. The interpreter itself never gains folder
access. Denied, interrupted, timed-out or changed-scope executions install no outputs.
Unsaved non-image files are inventoried then discarded; print text or structured data needed
by subsequent tools. Execution source, pins, results and approval remain in
the run history and activity export.

Each invocation lasts 1–120 seconds, with a 512 MiB process memory limit. Linux additionally
refuses child-process creation and executable replacement through a syscall filter inside the existing bubblewrap
namespaces. Windows uses a fresh AppContainer identity for every invocation, with no network
capabilities, a 512 MiB aggregate job-memory limit and one process, so child processes cannot start. Package inputs
are read-only; only private output and sandbox temporary storage are writable. The existing
Stop control ends the process tree. A 100 ms scratch guard stops runs exceeding 64 MiB,
512 entries or eight directory levels; this is a monitored limit, not a filesystem quota.
Returned files retain the existing 20 MiB/50-file bound. Links and Windows reparse outputs
are not collected. Console output retains the existing 1 MiB cap.

Forward-only schema 70 adds owner-local, content-free dispatch claims keyed by run, model
step and tool-call ID. An atomic claim checks the current owner, run mode, project scope,
tool policy and exact package hash. Duplicate calls and lost acknowledgements never replay
an execution. Interrupted claims require inspection and a fresh explicit request. Claims
are excluded from sync and portable exports; encrypted database backups retain them inert.
Delete-all removes claims and stops active native output producers. Private scratch copies
are removed after execution/cancellation; expired scratch from a process crash is removed on
startup or the next script request after three minutes. Windows cleanup revokes only that
invocation's runtime grants and profile. Backups, exports and sync contain no scratch copies.

The recorded browser scenario uses a throwaway HULK-style server, synthetic model replies
and a clearly marked system-Python fixture runtime. It exercises the real runner, approval
queue, native package validation, isolation and output collection. It does not authorize a
provider, install a production runtime or establish owner acceptance of a released build.
