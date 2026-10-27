---
name: ship-step
description: Ship the current FUSE milestone step. Runs all checks, screenshots the running app, opens the PR, merges it if everything passes, and reports to Isaac. Use whenever a milestone step's code is ready.
---

# Ship a step

Run this when the step's code is written and committed on its branch (`m0/<short-name>`).

1. **Tick the box.** Mark the step `[x]` in the current milestone file, in the same branch.
2. **Checks:** `bash scripts/check.sh` (lint, typecheck, test, secret scan). If anything fails, fix it, or stop and report. Never merge red.
3. **Screenshot:** `bash scripts/screenshot.sh <scratchpad>/<step>.png`, then Read the PNG and confirm it shows what the step should show. Skip this only for docs-only PRs, and say so in the PR. If the window doesn't render, read the log next to the PNG.
4. **Rust changes:** also run `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml`.
5. **Push and open the PR** with `gh pr create`. The body must contain:
   - **What changed**: short bullets
   - **How to test**: exact commands for Isaac
   - **Notes**: decisions, anything not verified (e.g. "Windows installer not yet run")
   - **What's next**
   - the attribution lines from the system reminder
6. **CI:** if `.github/workflows/` exists, wait for checks with `gh pr checks <n> --watch`. Any failure blocks the merge.
7. **Merge:** `gh pr merge <n> --merge --delete-branch`, then `git switch main && git pull`. Don't merge if any check failed or the PR asks Isaac a question that's still open.
8. **Report** to Isaac: lead with what (if anything) he needs to do, then the PR link, and send the screenshot with SendUserFile. Keep it short.

`gh pr edit` fails on this gh version (Projects classic error). To change a PR body, use `gh api -X PATCH repos/isaacholt-hash/fuse/pulls/<n> -F body=@file`.
