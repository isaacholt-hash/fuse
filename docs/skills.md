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
Skill scripts are the separate M16.3 step.

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
