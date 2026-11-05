# Microsoft and GitHub connectors

M15 builds first-party readers through FUSE's existing MCP registry. Microsoft replaces the
planned Google integration. Existing generic stdio/HTTP MCP servers remain available.

## Native account foundation (M15.1)

Registration and device authorization run on the installation whose account will be used:
Rust on desktop, or Rust on HULK for its web app and runner. A browser is not a separate
credential holder. There is no external authorization relay or embedded client secret.
Open Settings → Code & tools → Connections for shared registration/sign-in controls.
The same typed native participant serves desktop, browser and runner readers.

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

No registration or authorization is performed by the build. Registration instructions and the owner-operated acceptance checklist are below.
Tenant consent, conditional access and organization policies may refuse device authorization;
FUSE reports this and does not seek broader permissions or a secret-based fallback.

The native commands are `connector_configure`, `connector_status`, `connector_begin`,
`connector_poll`, `connector_disconnect`, `connector_project_access` and
`connector_prepare_delete`. Ordinary calls return only state, bounded account
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
A global data deletion prepares native credential retention/removal before deleting registration
rows and MCP servers. The existing separate choice about deleting credentials still applies.
A native-only owner index lets a later explicit credential erase find grants preserved by an
earlier data-only deletion, even after those registration rows are gone.

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
`outlook_calendar_read` for services explicitly selected in its account registration. Use Settings → Code & tools → Connections for account and project controls.
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
Shared setup is in Settings → Code & tools → Connections. The build does not authorize an account or install an App.

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

## Set up on a released installation (M15.4)

Update desktop and HULK through the normal release instructions before using these controls.
HULK updates, app registration, sign-in and project permissions are owner actions. The build
does not perform them. Existing generic MCP controls remain separate and unchanged.

Microsoft application registration:

1. In Microsoft Entra admin center → App registrations → New registration, choose an account
   type that supports the accounts you intend to use. For personal plus work/school accounts,
   select organizational directories plus personal Microsoft accounts; for one organization,
   its single-tenant registration can use that tenant explicitly. Organization policy may
   require an administrator's consent or refuse device authorization.
2. Under Authentication → Advanced settings, set Allow public client flows to Yes and save.
   Device authorization needs no redirect URI, embedded secret or external relay.
3. Under API permissions, use delegated Microsoft Graph User.Read and only the enabled
   services' Files.Read, Mail.Read and/or Calendars.Read. FUSE requests offline_access for
   native refresh. Do not add application permissions or read/write service scopes.
4. Copy the public Application (client) ID into FUSE → Settings → Code & tools → Connections →
   Add Microsoft account. Use common for both account kinds, consumers for personal,
   organizations for work/school, or the required tenant UUID/domain. Select services
   explicitly; none are preselected. Save registration, then choose Sign in.
5. Open the provider's sign-in page, enter the displayed device code, and finish consent as
   the intended account. Verify the displayed account address/name. Only then enable the
   desired projects. No folder is required for reader access. Saving/sign-in alone enables
   no project, model request, run or folder permission.

GitHub application registration:

1. GitHub → Settings (or the intended organization's settings) → Developer settings → GitHub
   Apps → New GitHub App. Give it a name and homepage; your own repository URL can be the
   homepage. Enable Device Flow and keep expiring user authorization tokens enabled.
2. Leave Webhooks Active off. Device flow ignores the callback URL; FUSE needs no callback,
   private key, client secret or relay. Use only repository Metadata, Contents, Issues and
   Pull requests Read-only permissions. No account/organization permissions are needed.
3. Install the App on Only select repositories, selecting the intended repositories. Its
   installation availability must cover their owner/organization; an organization may need
   to approve installation and SAML access. FUSE refuses all-repository or broader App
   permissions instead of changing them automatically.
4. In FUSE Connections → Add GitHub account, enter the public Client ID (Iv1./Iv23. prefix),
   not the numeric App ID, a PAT, client secret or private key. Save, choose Sign in, and
   complete the provider's device flow. Verify the account and explicitly enable projects.
   GitHub grants expire; FUSE asks for sign-in again rather than requesting a client secret
   for refresh. An active organization SAML session may be required before reauthorization.

Use the desktop controls for that computer's account or HULK's web controls for HULK's
account. Another browser uses HULK's authorization; it does not become a credential replica.
Project settings also list configured connections. Enablement binds the exact registration
and principal under the native account lock, so an old checkbox cannot enable a replacement
account or newly changed services. Project permission and its redacted audit commit together.
Changing an account/registration clears previous project access and requires explicit review.

Troubleshooting and removal:

- Denied or expired codes require an explicit new Sign in. Check the public client ID, device
  flow/public-client setting and tenant or organization policy. FUSE never requests a secret
  or broader scopes to bypass a refusal. Cancel sign-in clears this local account's access.
- Device checks respect the native interval. Leaving the panel pauses UI polling; reopen and
  refresh to continue its already-requested flow. A transport error pauses automatic polling
  until explicit refresh. A refused refresh/token clears authorization and project links; a
  temporary renewal outage preserves the grant for an explicit retry.
- Change account explicitly disconnects first and resets project access. Edit registration
  saves public settings and disconnects. Remove requires confirmation, clears local credentials
  and permissions, and removes registration; previously retrieved conversation content remains.
- Disconnecting FUSE is separate from provider-side revocation. Use GitHub Settings →
  Applications → Authorized GitHub Apps, the Microsoft personal account consent page, or
  work/school My Apps → Manage your application. A tenant administrator may control revocation.
- Data-only deletion preserves credentials when that existing option is selected, cancels
  pending sign-in and removes the registration that readers require. Choosing credential
  deletion erases registered/indexed native grants before their metadata disappears and
  clears registered generic MCP credentials too. Cleanup failure stops data deletion for an
  explicit retry. Native grant metadata is not a sign-in capability and never goes to sync.

Native storage and platform limits:

OAuth grants can exceed Windows Credential Manager's 2,560-byte entry limit. FUSE uses the
existing OS secret-store interface with at most 1,024 UTF-8 bytes per part (at most 2,048
UTF-16 bytes on Windows), a sixty-KiB record bound, two fixed slots and a small atomic
manifest. The old record remains readable until commit. Byte length and SHA-256 reject
missing/mixed/corrupt parts; fixed part names let explicit erasure cover interrupted writes.
The private owner index is recorded before credential parts are written. Old unchunked
grants remain readable; no re-enrollment or storage migration is required.

All manifests, parts and the owner index stay solely in the native secret store. They never
reach JavaScript, SQLite, sync, portable exports or FUSE database backups. Full encrypted
backups retain public registration metadata and local links; token loss still requires
provider sign-in. New public status includes a bounded Microsoft account hint, never tokens.
No new table, portable column or dependency is introduced by these controls. The build grants no access.

[Microsoft public-client configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration),
[GitHub registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[Windows credential entry bound](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentiala).

## Released owner acceptance — pending

Automated authorization, paging, revocation, read bounds, project/provider isolation and UI
scenarios use isolated fixtures. They do not establish live provider/tenant acceptance. After
updating the released desktop/HULK builds, the owner records build IDs, account type/tenant,
date and result in M19: real Microsoft personal/work sign-in and selected readers; GitHub
App/organization sign-in and selected repository/issue/PR reads; project/provider denial;
expiry/re-sign-in; disconnect/provider revocation and preserved conversation content. Keep
actual tokens and device codes out of chat, screenshots and acceptance records. No such live
authorization has been performed by this build.
