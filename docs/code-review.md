# Code review

In Code, open **Options → Review code**, or use **Ctrl+Shift+P → Review code**. Review
runs on the installation you are using: this desktop, or HULK when using its web app.
Opening setup preserves the current editable draft and makes no provider request. Starting
creates a separate Code conversation in the same project, with the chosen read-only mode
and spending cap. Review does not modify files, execute commands/tests, push or post comments.

Choose local changes, a branch comparison, or a GitHub pull request. Local review requires
an existing linked repository folder. Changes include the combined staged/unstaged working
tree and eligible untracked files against HEAD. Branch review compares its pinned head with
the merge base of the requested base/head. It never checks out or creates a branch.

GitHub review needs a built-in account explicitly enabled for this project on this execution
owner, under Settings → Code & tools → Connections. Enter the PR URL and choose that account;
a folder is not required. Discovery uses the existing bounded read-only MCP readers, with a
twenty-page total discovery limit. The selected App must grant only the approved read access
to that repository. Public repository visibility alone does not grant access. No authorization
or permission is added by reviewing history. See [connector setup](connectors.md).

The source is pinned before planning. For GitHub comparisons, old-side evidence comes from
the **merge-base commit**, including a renamed file's previous path; new evidence comes from
the pinned head. An expected-head check refuses a PR that moves during capture. A later edit
never changes a completed report's recorded revision. For uncommitted local files, a SHA-256
snapshot identifies the captured bytes. Local HEAD, changed paths and captured bytes are
checked again before capture finishes.

A snapshot contains at most twenty changed text files, 64 KiB per side/file and 256 KiB total.
GitHub capture uses the first 1,000 lines / 30,000 characters of a complete file; a larger file,
unavailable patch, API ceiling, binary file, symlink, submodule or excluded path is listed as a
limitation. Local repository ignores and sensitive-file grants still apply. GitHub review
excludes secret-looking paths. Partial coverage cannot establish that the remaining code has
no defects. An empty eligible snapshot returns a local result without a provider request.

Auto uses the shared router: Best planning and final synthesis, and the eligible routine
model for analysis. Explicit model/tier choices remain respected. Every stage reserves its
conservative cost against the same run/global/project budgets before dispatch. Incurred and
unknown charges remain in Usage even if findings fail verification. There is no blind paid
retry. A paused or interrupted review continues only when you choose Continue; a missing or
unusable previous response may require a new paid request, as its status explains. A final
response already committed before interruption is published without requesting it again.

Findings include severity P0–P3, a concrete trigger/consequence, path, old/new side, revision,
line range and exact quoted evidence. FUSE verifies the snapshot identity, path, revision,
line bounds, quote and overlap with changed lines before accepting findings. Those checks
verify locations and source evidence; the described consequence remains a model judgment.
Invalid findings remain local diagnostic evidence and cannot appear as accepted findings.
No findings is not a guarantee of correctness, and review does not claim to have run tests.

Captured source, preliminary analysis, request journal and execution lease stay in local
`review_state` / `review_operations`. They are excluded from sync and portable exports. The
completed report and its bounded evidence quotes follow normal conversation/history privacy
settings. A portable review profile prevents replicas or missing checkpoints from resuming
through generic Code execution. Delete-all and final history deletion remove the local
checkpoint through the existing deletion path. Encrypted full-database backups retain these
local records under their separate retention policy; restoring a backup never starts a run.
Update desktop and HULK before using the new schema together; live deployment stays an owner
action. No provider keys or machine permissions are stored in the source snapshot.
