# Parallel Code work

M16 step 4 adds the execution foundation. Step 5 adds dedicated child progress/review and
approved integration controls. In a writable Code session, `delegate_code` proposes one to
three independent tasks. The existing approval card shows the tasks, committed base revision
and combined cap. Denial creates no child, worktree or paid child request. Read-only reviews,
Work and plain Chat cannot delegate. Children cannot delegate again or use Git tools directly.

Each child runs on the parent's execution owner, in its own `fuse/child/<UUID>` branch and
app-managed worktree, starting from the approved committed HEAD. Parent uncommitted content
is excluded. The child receives only its own folder; other project/chat folders and secret
file grants are excluded. Ask-first edits still ask. Every child command and network retry
asks separately; even an Always answer applies once, without creating project or network grants.
The parent presents the exact child's approval, labelled with its branch. No child changes
are integrated, committed, pushed or turned into a PR by delegation.

Planning and synthesis retain the parent's Best selection; routine child work retains its
selected model and quality floor. Explicit model pins remain respected. Local models remain
housekeeping-only. Every dispatched request reserves a conservative bound transactionally
against the parent's cap, including outstanding sibling requests and unknown billing. Actual
receipts update child and parent totals once; they remain single request-ledger records.
An insufficient next-operation bound pauses execution. Unknown billing retains its reservation
and never triggers a blind paid retry. Creating worktrees itself makes no provider request.

## Isolation and limits

An enabled, functioning OS sandbox is required. Worktree creation uses fixed Git operations
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
separate results, unchanged dirty parent, no integration and one receipt per model request.
Windows runs the native worktree and private-command probes in CI. Fixture results establish
these bounded behaviors; live provider-backed quality remains owner acceptance in M19.
