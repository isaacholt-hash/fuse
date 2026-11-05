# Research in Chat

Open Chat → Options → Research. A linked folder is not required. Review or edit the scope,
select any context you want included, choose the execution location and enter a spending cap.
The cap starts empty for every new run. The estimate is approximate; the engine reserves a
conservative bound before each request and pauses if the next request cannot fit.

Auto uses Best for planning, synthesis and support review, with a bounded search worker at
the required quality floor. Explicit model pins stay pinned. Unsupported pins show a reason
instead of silently changing models. Currently only OpenAI hosted search has the documented
hard action bound required for accounted research; an OpenAI connection is therefore needed
on the execution owner. Anthropic can perform non-search Best stages. Local models remain
housekeeping only. Prices and overrides come from the execution owner's accepted catalog.

## Location and context

HULK is preferred when paired, compatible, permitted and configured with eligible providers.
The browser runs research on HULK; it explains why desktop execution is unavailable. The
desktop also offers This computer explicitly. Choosing a location never falls back silently.
Neither location grants commands, repository writes, Python or additional MCP access.

No context is selected by default. Choose individual memories, artifacts, messages or
instruction scopes. Incognito content, conflicted memory and prohibited context are excluded.
HULK receives only the reviewed text snapshot through its existing authenticated native HTTPS
connection. Local-only content cannot transfer. Research from a desktop project requires that
same project already exist on HULK, normally through enrolled sync; FUSE never replaces its
configuration with a partial project. Outside-project research does not require sync enrollment.
A desktop-to-HULK start creates a dedicated Research Chat in that project. It copies no folder
grant, permission or credential. Your ordinary editable Chat draft is preserved.

## Progress, pause and continuation

Progress shows the stage, searches, page reads, model calls, actual spend, reserved exposure and
any unknown billing. Pause lets an in-flight operation settle before parking. Stop interrupts
execution and preserves evidence and incurred charges. Continue requires an explicit action
and confirmation of the total cap, including spending already incurred.

HULK's background runner continues when a browser or calling desktop disconnects. Desktop
execution becomes interrupted when its process ends; restarting the app or opening synced
history never resumes it. The execution owner retains its checkpoints. Replicated history is
read-only; use the existing HULK interface for HULK controls. A lost start acknowledgement is
shown as uncertain and observed by its stable ID; FUSE does not blindly resend paid work.

Limits are 12 searches, 24 fetched sources, 30 model calls and 30 active minutes. Reaching a
limit produces a labelled partial report. Unknown billing remains unresolved and consumes its
remaining hold. A request whose dispatch/result is ambiguous is never automatically replayed.

## Reports and storage

Reports are versioned Markdown artifacts with collected source links, query/time provenance,
quoted support, limitations and unresolved disagreements. Unsupported claims stay visibly
unverified. A support review cannot establish that an external source is correct. Sources are
untrusted; flagged instructions are excluded from model evidence.

Completed reports, messages and run evidence use normal privacy, sync, deletion and export
rules. Owner-local checkpoints, attempt journals and transfer intents are excluded from sync
and portable JSON export. Encrypted database backups retain them under the existing backup
policy. Restoring a backup never dispatches or resumes research. Deleting a source Chat clears
its local transfer intent; changing it to local-only withdraws any retained pending payload.
Backups have their separate retention policy; sync is not a backup.

## Updating and owner acceptance

Install the released desktop build through the normal updater. Independently update HULK
using the existing [server update procedure](hulk-server.md); do not re-enroll devices. Both builds
need the matching schema and research protocol. This build does not deploy or enable anything
on the existing HULK installation.

After updating, the owner should start a small capped Research run, review scope/cost/location,
pause and continue explicitly, inspect its cited report and verify HULK continues after closing
the caller. Live provider and deployment acceptance must be recorded against the released
desktop/HULK builds. Synthetic fixtures do not establish live provider availability or quality.
