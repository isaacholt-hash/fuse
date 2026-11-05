# Parallel Code work

M16 provides isolated child execution, progress, review and explicitly approved integration. In a writable Code session, `delegate_code` proposes one to
three independent tasks. The existing approval card shows the tasks, committed base revision
and combined cap. Denial creates no child, worktree or paid child request. Read-only reviews,
Work and plain Chat cannot delegate. Children cannot delegate again or use Git tools directly.

Each child runs on the parent's execution owner, in its own `fuse/child/<UUID>` branch and
app-managed worktree, starting from the approved committed HEAD. Parent uncommitted content
is excluded. The child receives only its own folder; other project/chat folders and secret
file grants are excluded. Ask-first edits still ask. Every child command and network retry
asks separately; even an Always answer applies once, without creating project or network grants.
The parent presents the exact child's approval, labelled with its branch. Delegation leaves changes in the child worktrees. Commit and integration require the explicit review controls described below.

Planning and synthesis retain the parent's Best selection; routine child work retains its
selected model and quality floor. Explicit model pins remain respected. Local models remain
housekeeping-only. Every dispatched request reserves a conservative bound transactionally
against the parent's cap, including outstanding sibling requests and unknown billing. Actual
receipts update child and parent totals once; they remain single request-ledger records.
An insufficient next-operation bound pauses execution. Unknown billing retains its reservation
and never triggers a blind paid retry. Creating worktrees itself makes no provider request.

## Isolation and limits

An enabled, functioning OS sandbox and an explicit repository/worktree root are required. Git does not discover an ancestor outside the selected folder or follow a configuration override to another working folder. Linked worktrees must have a matching Git back-pointer. Worktree creation uses fixed Git operations
and bounded raw committed objects, avoiding checkout filters and hooks. Unsupported links,
submodules, nonportable or case-colliding paths fail closed. Setup permits at most 10,000
files, 16 MiB per file and 128 MiB total. Secret-looking filenames are omitted without reading
their blobs; their index entries are marked skip-worktree. Parent index and dirty files remain
unchanged. A changed commit or working-tree metadata fingerprint invalidates preparation.

Linux child commands receive public system executables/libraries and only their own writable
worktree, with Git metadata masked, a private temporary directory and a cleared environment.
Tools installed in private user folders are unavailable. Windows uses a unique AppContainer
per command, scoped to its own worktree; ambient parent/sibling container grants do not apply.
Both retain existing explicit network restrictions. Commands last at most ten minutes.
Linux limits each process to 2 GiB of virtual address space; Windows limits the whole job to
2 GiB and at most 64 processes. Linux temporary storage is bounded to 64 MiB. A native monitor checks worktree growth against 512 MiB / 20,000 entries
and stops commands after parent/owner/tool authority changes. This is a monitored bound,
not a filesystem quota: transient growth can exceed it between checks.

## Stop, interruption and history

Stop/pause propagates durably to children. Native command supervision and the execution
owner's worker continue independently of open tabs. A HULK-owned run can finish after the
caller disconnects. Desktop execution stops with its owner. Startup marks unfinished child
claims interrupted and retains worktrees and billing evidence; neither startup, sync nor
Continue automatically replays a child. Explicit parent continuation fills a missing tool
result with retained interruption information. Live children prevent duplicate continuation.

Completed/interrupted child history and its parent relationship can sync. A missing parent
stages the history until it arrives. Receiving history grants no access or execution.
Worktree paths, Git pointers, dispatch claims, folder/command/network permissions and active
execution remain owner-local. Replicas show history read-only. Privacy withdrawal removes
remote parent/child history without deleting the owner's local worktree.

## Retention and deletion

Schema 71 classifies the portable `runs.parent_run_id` and the entirely local `code_children`
claim table. Portable exports exclude execution claims and folders. Encrypted database
backups retain inert claim metadata under the separate backup policy; worktree bytes live
outside the attachment store and are excluded from sync, portable exports and database
backups. Restoring a backup never starts children.

Failed or interrupted worktrees are preserved for diagnosis. Global deletion stops active
child commands before removing only app-owned UUID worktree directories; it never follows
Git pointers or deletes the linked parent repository. Git administrative entries and shared
repository objects have their own retention. After reviewing retained evidence and removing
an obsolete worktree, the owner may use Git's normal worktree prune / object retention tools
in the parent repository. Removing FUSE history is not a promise to erase repository objects,
backups or external copies.

## Recorded verification

`pnpm exec vitest run src/parallel src/storage/requestBudget.test.ts` covers independent edits,
combined reservations/receipts, denied delegation, recursive/unoffered tool refusal, Stop,
crash recovery and approvals that cannot widen grants. Native `code_worktrees::` tests use
real disposable Git repositories and OS isolation. `bash scripts/parallel-web.sh` uses a
throwaway native server, background runner, in-memory test secrets and synthetic models:
it denies one proposal, approves two child edits, disconnects the caller and checks exact
separate results, unchanged dirty parent and one receipt per model request. It then explicitly
reviews/commits both children, retains a conflicting integration refusal, rejects a stale
parent, and approves one exact child into a fresh branch/worktree. A lost commit response is
recovered from the owner journal without replay. These repository actions make no extra
provider requests. `pnpm parallel:bench` records these checks plus the native security and
shared accounting/UI suites in `src-tauri/target/parallel-benchmark.json`.
Windows runs the native worktree and private-command probes in CI. Fixture results establish
these bounded behaviors; live provider-backed quality remains owner acceptance in M19.

## Reviewing and integrating child work

Children with an inherited planner use the existing Best (or explicitly pinned) planning model before routine execution; planning and final synthesis reserve and settle against the same combined cap. The parent card shows each approved task, recorded plan, progress, status and cost, plus
one combined total and outstanding reservations. Stop child changes only that owner's running
child; its files and billing evidence remain. A stopped/paused parent never restarts a child
through Continue. Open the original owner to use repository controls on retained history.

After execution stops, **Review changes** captures the child's exact revision and bounded
text diff. Opening or cancelling review changes no Git ref. **Commit reviewed child**
rechecks the same bytes, parent and Git pointer, then commits only that child. The dialog
explicitly shows the application author/committer, `FUSE <fuse@local>`; these commits are not
attributed to the model or silently given the owner's Git identity. No signing program,
checkout filter or repository hook executes.

**Review integration** starts with no selected commits. Select exact child revisions, review
the combined diff, then choose **Approve integration branch**. This creates a new
`fuse/integration/<UUID>` branch and app-managed worktree whose commit parents include the
pinned original base and the selected child commits. The original folder, index, branch and
dirty files remain intact; uncommitted parent work is excluded from the result. Use the
existing Code/Git workflow to review or use that branch, or explicitly link the resulting
worktree for a new task. This action starts no run, makes no provider request, pushes nothing
and publishes no PR.

Different child edits to the same path pause integration when their object identities differ;
identical changes coalesce. File/directory and case collisions are refused. The parent must
still match the delegation revision/fingerprint, and the approved review also pins its index.
Any changed parent, child, file or Git pointer requires a fresh review. This conservative
merge does not guess how overlapping source edits should combine; all versions remain in
retained child commits/worktrees.

Review supports at most 100 changed UTF-8 text files, 256 KiB per changed file and 1 MiB of
before/after text. Scanning is limited to 10,000 paths / 256 MiB and one minute. Larger/binary
changes require manual review. Secret-looking paths, links/reparse points and hard links are
refused. A review expires after 30 minutes. These limits restrict repository operations,
independently of provider spending caps.

## Interrupted repository actions

Review tokens, candidate commits, result branches and acknowledgement state are durable on
the execution owner. The candidate is recorded before updating a child ref or creating the
integration worktree. Duplicate delivery of a completed approval returns its recorded result.
An interrupted operation never runs automatically again, even after restore or reconnect. If an acknowledgement is lost after the owner durably committed the result, the UI confirms completion from that record without issuing the operation again.
Inspect its retained branch/worktree, then explicitly **Keep evidence and release interrupted
claim** before a fresh review. A failed acknowledgement may follow a successful Git write;
its result is shown as retained evidence rather than silently treated as an unexecuted action.

Schema 72's `code_child_reviews` stores local bounded snapshots and attempt state. It is
excluded from sync and portable exports, cascades with run deletion, and remains inert in
encrypted database backups. Repository bytes remain outside those backups. Successful owner
actions add content-free revision/branch metadata to the existing run activity audit, with
approval `you` and no extra cost. Model continuation receives this as data, not as an invented
provider tool result. Global deletion refuses while a reviewed mutation is still active;
retry after it stops to purge owned worktree bytes. Git objects, admin entries, independent
backups and external copies retain their separate policy.

Raw object operations follow Git's [hash-object](https://git-scm.com/docs/git-hash-object),
[mktree](https://git-scm.com/docs/git-mktree), [commit-tree](https://git-scm.com/docs/git-commit-tree)
and [compare-and-swap ref update](https://git-scm.com/docs/git-update-ref) interfaces.
