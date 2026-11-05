# Microsoft and GitHub connectors

M15 builds first-party readers through FUSE's existing MCP registry. Microsoft replaces the
planned Google integration. Existing generic stdio/HTTP MCP servers remain available.

## Native account foundation (M15.1)

Registration and device authorization run on the installation whose account will be used:
Rust on desktop, or Rust on HULK for its web app and runner. A browser is not a separate
credential holder. There is no external authorization relay or embedded client secret.
Shared registration/sign-in controls arrive in M15.4; this step exposes the typed native
foundation, with no connector reader offered before its subsequent step.

Owner-registered applications:

- Microsoft: register a public client supporting personal accounts and organizational tenants
  as required. Enable public client/device authorization. Use `common` for both account kinds,
  `consumers` for personal accounts, `organizations` for work/school, or a specific tenant.
  Request delegated `User.Read` for the displayed account identity and `offline_access` for
  native refresh. Add only `Files.Read`, `Mail.Read` and/or `Calendars.Read` for services the
  owner enables. Never add application permissions or delegated write access.
- GitHub: register a GitHub App and enable device flow. Use its public client ID (not its app
  number or an OAuth App ID). Its repository permissions must be read-only and installation
  limited to the intended repositories. Device authorization requests `offline_access` to
  obtain an expiring grant. FUSE does not store or use its refresh token: renewal requiring a
  client secret instead asks the owner to sign in again. Never enter an application secret.

No registration or authorization is performed by the build. Final registration instructions,
account setup and the owner-operated acceptance checklist accompany M15.4's released controls.
Tenant consent, conditional access and organization policies may refuse device authorization;
FUSE reports this and does not seek broader permissions or a secret-based fallback.

The native commands are `connector_configure`, `connector_status`, `connector_begin`,
`connector_poll` and `connector_disconnect`. Ordinary calls return only state, bounded account
identity/label, expiry, the public verification address/user code and poll timing. The device
credential, access token and refresh token never return to JavaScript. Requests use fixed
provider endpoints, HTTPS, no redirects, bounded bodies and generic errors that discard
provider descriptions. Device sessions expire within thirty minutes, use monotonic timing and
respect polling intervals and slowdown. Reopening setup observes its existing session.
Cancellation/disconnection and registration changes serialize with polling and refresh;
a canceled or superseded flow cannot later install a token.

Microsoft refreshes natively without a client secret. GitHub expiry requires explicit sign-in.
A successful grant records the account identity so setup can show which account was chosen.
Changing accounts, client IDs, tenants or enabled services clears old native authorization and
all project links for that account. Consent does not switch any project on. Selective readers
must still pass ordinary provider restrictions and approvals before returning model context.

Disconnect removes local native authorization and pending sign-in. It does not revoke the
provider's authorization: remove the application in the Microsoft account's application
permissions or GitHub Settings → Applications → Authorized GitHub Apps as well when required.
Already retrieved conversation content follows FUSE's normal content/deletion rules.

## Storage, backup and privacy

`connector_accounts` contains only public registration settings and enabled service names.
`mcp_servers.builtin_kind` selects the built-in participant without starting a process or
following a remote URL. Both are installation-local, excluded from sync and portable exports.
Project links are the existing local MCP permissions. Full encrypted database backups contain
registration metadata and links; credentials remain separately in the native secret store.
Restoring a database provides no new token and never starts sign-in. Native grants are bound
to the exact account registration; they cannot follow a restored, mismatched configuration.
A global data deletion removes registration rows before MCP servers; the existing separate
choice about credential deletion still applies. Disconnect accounts before removing their
registration when their native credentials must also be erased.

Sign-in, refresh, credential use and consent/configuration changes write redacted security
activity using opaque connector IDs. Activity contains no user code, account address, OAuth
body or credential value. Device codes are process memory only, never in SQLite, sync, exports
or backups. A process restart discards pending sign-in; completed native grants survive.

## Protocol references

Verified 2026-11-05 against the maintainers' documentation:

- [Microsoft device authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
- [Microsoft personal and work/school account support](https://learn.microsoft.com/en-us/graph/users-you-can-reach)
- [Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [GitHub App device authorization and token renewal](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

Tests use a throwaway encrypted database, in-memory secret store and isolated loopback OAuth/API
responses. No real account, provider key or deployed HULK installation is used. Real personal/
work accounts, denied tenant consent and released installation sign-in remain owner checks.

## Updating desktop and HULK

Schema 67 requires updating both participants through the normal release instructions before
using accounts on each. Updating does not deploy HULK automatically, sign in to any service,
re-enroll a device, grant a project access or transfer connector credentials. Existing sync
pauses on incompatible schema versions while preserving pending local changes. Authorize the
account separately on each execution owner where its readers are needed.

## Microsoft readers (M15.2)

The native participant offers `onedrive_list`, `onedrive_search`, `onedrive_read`,
`outlook_mail_list`, `outlook_mail_search`, `outlook_mail_read`, `outlook_calendar_list` and
`outlook_calendar_read` for services explicitly selected in its account registration. Shared
setup/project controls arrive in M15.4; this step supplies the verified readers and call path.
No owner account is signed in by this build.

A request must identify its originating conversation/project and chosen model provider,
separately from the model's tool arguments. Rust resolves the actual project, checks its local
MCP enablement and current egress policy, then checks again before returning content. A moved
conversation, revoked project link, disabled service, local-only scope or blocked provider
fails closed. Project-only Code/Work runs use their explicit project scope. Consent on one
installation provides no account or project permission on another installation or HULK.

All operations use GET; reading mail does not mark it read, send it or download attachments.
Calendar reads never schedule/respond, and file reads never install bytes, execute macros or
grant folder access. Mail listing/search includes the signed-in mailbox's archived/deleted
folders; it returns previews until a message is selected explicitly. Calendar listing requires
an explicit UTC range, at most 31 days, between 1970 and 2100. Native request construction
encodes identifiers/queries; callers cannot supply an arbitrary Graph URL or method.

Limits and continuation:

- Ten results per page and at most ten pages per traversal. The limit produces a labelled
  partial result and asks for a narrower selection.
- Native response bodies are capped at 512 KiB. Next links must retain the selected Graph
  origin/resource. They never return to JavaScript: a random, single-use cursor is bound to
  the registration, conversation/project, provider and reader, expires after fifteen minutes
  and disappears on process restart. A wrong caller cannot consume a valid caller's cursor.
- Read bodies return at most 30,000 characters, with a truncation flag. Message/event detail
  includes up to eight recipients/participants, plus the source identity, revision and link.
- OneDrive downloads are capped at 4 MiB; images at 3.75 MiB. File text is returned in bounded
  30,000-character portions; repeat the selected revision with an offset for more text.
- Word/Excel archives are checked before expansion: 256 entries, 4 MiB per entry, 8 MiB total.
  The existing text parsers read content/formulas without executing them. PDF text extraction
  is bounded to forty pages and 200,000 characters, with page provenance and an explicit limit
  marker. Empty text files are valid; image-only PDFs explicitly report that text extraction is
  unavailable and require an intentionally attached PDF for model vision. The same bundled
  PDF parser works on desktop, browser and Node/HULK without a new
  dependency, external worker file or native addon.

Files are checked against their selected revision and rechecked after download; incomplete
bytes, a changed revision or a failed published SHA-256 check return no content. Provenance
records the actual downloaded SHA-256. A Microsoft download redirect is handled only in Rust:
its preauthenticated URL never reaches JavaScript, the model, activity or the file store.
Every hop must remain on a supported public Microsoft download host, with DNS pinned and no
proxy, bearer token or cookies. Requests are size/time bounded and are never retried blindly.

Only allowed metadata fields are returned. Message/event HTML becomes text without scripts,
styles or active embeds. Content remains untrusted tool data through the existing injection
flagging and approval pipeline; a source cannot confer permissions or become an instruction.
Downloaded original document buffers are discarded after interpretation. Returned text/images
are ordinary conversation content and follow that conversation's privacy, sync, export and
backup rules; no knowledge-file import happens automatically. Account grants and cursor state
remain local; there is no new replicated table or portable permission.

Each actual Graph/download credential use records an opaque account event, without query,
subject, URL or credential values. Provider errors discard their bodies. A rejected token
clears local authorization and project links before future reads; signing in and enabling the
project again are explicit actions. Tenant denial/rate limits are actionable errors and do not
cause broader scopes, writes or automatic retries.

Protocol references, verified 2026-11-05:

- [OneDrive folder listing](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0)
- [OneDrive search](https://learn.microsoft.com/en-us/graph/api/driveitem-search?view=graph-rest-1.0)
- [File download and preauthenticated redirects](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
- [Mail listing, paging and plain-text body preference](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Message reads](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0)
- [Calendar view and explicit time ranges](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)
- [Event reads](https://learn.microsoft.com/en-us/graph/api/event-get?view=graph-rest-1.0)

## GitHub readers (M15.3)

The built-in participant offers `github_installations`, `github_repositories`,
`github_repository_read`, `github_issues`, `github_issue_read`, `github_comments`,
`github_pulls`, `github_pull_read`, `github_diff_read` and `github_file_read`. All use the
same project enablement, recipient policy, approvals and untrusted-content checks as Microsoft.
Shared setup remains in M15.4. The build does not authorize an account or install an App.

Install the owner-registered GitHub App on **Only select repositories**. Enable only Metadata,
Contents, Issues and Pull requests **Read-only** repository permissions; no organization or
account permissions or webhooks are needed. Native readers check the selected installation's
reported permissions and repository membership before every read. An installation with write
or unrelated permissions is refused, even if a particular endpoint would permit a GET. A
public repository is not eligible merely because GitHub allows public reads: it must occur in
the selected installation's accessible repository list. This account/App intersection is
checked again on subsequent calls, without a persistent permission cache.

Limits and evidence:

- Fixed `api.github.com` HTTPS endpoints, GET only, redirects disabled, twenty-second native
  request timeout, two MiB maximum response, and no automatic retries. API version is
  `2026-03-10`. Returned source URLs are constructed locally; API download/HTML URLs are not
  followed or passed through. Errors omit provider bodies and token values. A rejected token
  clears the grant and local project links; expiry asks for explicit sign-in.
- Ten results per page, at most ten pages. Opaque single-use cursors are bound to the account
  registration, conversation/project, recipient, reader and original selection; they expire
  after fifteen minutes and disappear on restart/disconnect. The installation/repository
  membership check is bounded to 100 entries each; narrow the App's selected repositories if
  the required repository lies outside that bound. Reaching a traversal limit is explicit.
- Issue text filtering applies within each fetched page, with further pages available through
  its cursor. Issue/PR bodies and comment bodies are capped at 30,000 characters and labelled
  when truncated. Conversation comments are separate reads; inline review comments and
  attachments are not implicitly fetched. Content is data, never an instruction or permission.
- Repository reads resolve a selected branch/tag to an immutable commit. PR reads return base
  and head commits, including fork provenance; `expectedHead` refuses a stale selection.
  Diff reads require full base/head SHAs and return the three-dot comparison's merge base.
  Ten changed files per portion include path, previous path, blob revision, and checked
  old/new hunk line numbers. Missing, malformed or oversized patches remain explicitly partial.
  The API's 300-file ceiling is also labelled partial; no complete-review claim is inferred.
- Text-file reads walk the exact commit's nonrecursive Git trees (at most 24 path components),
  verify directory/blob identities and ordinary file modes, then fetch the exact raw blob.
  Symlinks/submodules are refused, including intermediate path components. Truncated trees,
  oversized directories/responses, mismatched revisions, incomplete bytes, binary data and
  non-UTF-8 content fail visibly. Files are at most one MiB; portions return up to 1,000 lines
  and 30,000 characters, with exact line numbers, next-line offset, blob SHA and actual
  SHA-256. Executable-mode text is read as data and is never executed.

These tools never clone repositories, edit files, run commands, grant folders, post reviews or
comments, push or merge. No account crawl occurs in the background. Native request audit uses
only opaque connector IDs; credentials and temporary cursors stay on the execution owner.
Returned text follows the conversation's existing sync/deletion/export/backup policy. This
step adds no table, migration, portable column or dependency.

Protocol references, verified 2026-11-05:

- [User-accessible App installations and repositories](https://docs.github.com/en/rest/apps/installations)
- [Issues](https://docs.github.com/en/rest/issues/issues) and [conversation comments](https://docs.github.com/en/rest/issues/comments)
- [Pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [Immutable comparisons and their file ceiling](https://docs.github.com/en/rest/commits/commits)
- [Pinned Git commits](https://docs.github.com/en/rest/git/commits), [tree modes](https://docs.github.com/en/rest/git/trees) and [raw blobs](https://docs.github.com/en/rest/git/blobs)
