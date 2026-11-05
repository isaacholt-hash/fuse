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
