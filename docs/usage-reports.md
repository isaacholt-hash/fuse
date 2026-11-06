# Provider usage reports (M18.3)

Settings → Costs & limits → **Provider usage reports** compares FUSE's own costs with what each
provider reports. It is off until you set it up.

## Reporting keys

Each provider needs its own **reporting key**, separate from the chat key. FUSE never uses a
chat key for reports or a reporting key for chats.

| Provider | Key | Where | Who can create it |
| --- | --- | --- | --- |
| OpenAI | Admin key (`sk-admin…`) | platform.openai.com → Settings → Organization → Admin keys | Organization owners |
| Anthropic | Admin API key (`sk-ant-admin…`) | platform.claude.com → Settings → Admin keys | Organization admins (not individual accounts) |

Keys go into this device's secret store (or HULK's systemd-creds) and are shown only as
saved or not saved.

## What FUSE reads

Only these read-only reports, for the last seven UTC days, one bucket per day:

- OpenAI `GET /v1/organization/costs` (grouped by project, line item and key) and
  `GET /v1/organization/usage/completions` (grouped by project, model and key).
- Anthropic Usage and Cost Analytics `GET /v1/organizations/analytics/cost` and
  `/analytics/usage` (grouped by model, workspace and key; beta header
  `analytics-usage-cost-2026-08-24`).

Pages are followed to the end (at most 40 per run). A complete run replaces the window's
earlier rows, so late corrections take effect. A failed run (key refused, rate limited,
unreadable reply) keeps the last good report and records only a fixed message: never the
key, headers or the provider's reply. Collection runs every six hours while FUSE is open,
and on **Refresh now**. Anthropic data can lag 4–24 hours and is revised until about seven
days after a month ends.

## Who collects

On the desktop, choose **This computer** or **FUSE on HULK**. With HULK, set up the
reporting keys in HULK's Settings; the desktop then skips collection. Each collector keeps
its own reports, which don't sync.

## Usage CSV

**Export usage CSV** writes FUSE's requests (`source` `fuse`) and the collected or imported
report rows in one file. Columns: `source, date_utc, provider, kind, scope, key_id,
model, line_item, currency, amount, input_tokens, output_tokens, cached_tokens, requests`.
Amounts are USD with six decimals.

**Import report CSV** reads the same columns (`date_utc`, `provider`, `kind` and `amount`
required): the fallback without admin access. FUSE's own `fuse` lines are skipped. A file
with any invalid line imports nothing. Re-importing a day and scope replaces it. The
providers' console CSV exports don't document their columns, so rename them to these
first.

Reports never count as spend. Comparing them with FUSE's costs is M18.4.
