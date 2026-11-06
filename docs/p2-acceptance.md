# P2 owner acceptance

The unattended P2 build is done through M19.1. **P2 closes only after you run these checks on
a released build and they're recorded in [M19](milestones/M19-p2-acceptance.md).** Nothing
below needs a key typed into chat; use the app's own settings.

## Builds

Install the latest release (Windows or Linux) from
https://github.com/isaacholt-hash/fuse/releases. The desktop updates itself. Update HULK
after the desktop, using the steps in [hulk-server.md](hulk-server.md) (`scripts/deploy-server.sh`);
nothing deploys HULK automatically.

## Checks

| # | Area | What to do | Passes when |
| --- | --- | --- | --- |
| 1 | Dictation (M13) | Allow audio once, dictate a sentence in Chat, edit it, send | Text lands in the draft, nothing sends by itself, cost shows |
| 2 | Deep research (M14) | Start research in Chat with a cap you choose (e.g. $1) | A cited report finishes under the cap; stopping and resuming works |
| 3 | Connectors (M15) | Connect a Microsoft account and GitHub in Settings; enable for one project; ask for a OneDrive file, an email, a calendar day and a PR | Each read works only in that project; disconnect removes access |
| 4 | Writing canvas (M17.2) | Open a document, Shorten a section, review the diff, accept; add a comment | A new version only after Accept; the comment stays on its passage |
| 5 | Python artifacts (M17.3) | Run a Python artifact with a CSV input | Output beside the code; no network; attempt recorded |
| 6 | Offline (M18.1–2) | Go offline, queue two messages, reconnect | They send in order; a price or budget change holds for Send now |
| 7 | Usage reports (M18.3–4) | Add admin reporting keys, Refresh now, then open Usage | Reports collected; the comparison shows; no new spend |

Record the release version, date and result of each in M19 step 2. A check you skip stays
marked as skipped.
