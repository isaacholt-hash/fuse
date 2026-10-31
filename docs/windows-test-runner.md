# Tests on Isaac's Windows PC (M8 step 15)

A GitHub Actions runner on your PC runs `.github/workflows/pc-tests.yml` after each release, and when you start it by hand. It does three things:

1. Runs the click-through tests (step 14) on your real desktop.
2. Runs the real update test: it installs the release before the newest, lets it find and download the newest, presses **Restart now**, and checks the newest is running.
3. Runs `pnpm local:bench`, if a local model is installed.

Results go to the run's summary and the build tracker. A failure opens an issue and never blocks merging.

## Safety

The repository is public, so the runner must never run a stranger's code.

- `pc-tests.yml` only runs after a release from a push to main, or when you start it by hand. It never runs on pull requests.
- **GitHub setting, required:** Settings → Actions → General → "Approval for running fork pull request workflows from contributors" → **"Require approval for all external contributors"** (the strictest choice). A pull request could otherwise add a job with `runs-on: [self-hosted, fuse-pc]` to another workflow. With this setting, no workflow runs for an outsider's pull request until you approve it. Only approve pull requests you have read.
- The runner runs as your normal user, not as a service, so it can open windows. It has your rights. Don't add a key or any other secret to it: step 16 reads keys from your own environment, and only when you start that workflow.
- One job at a time (`concurrency: pc-tests`).

## What the tests touch

- The click-through tests use the separate test build, "FUSE E2E", with its own data folder. Your chats and settings aren't touched. They make `C:\fuse-e2e`, and check that nothing appears in `Documents\escape.txt`.
- **The update test installs over your real FUSE.** It skips itself if FUSE is open, so close FUSE to include it. Your chats stay, as with any update. Afterwards the newest release is installed, as before.

## Setting it up (once, about 20 minutes)

1. Install the build tools, if they aren't there already:
   - [Rust](https://rustup.rs) (stable), with the "Desktop development with C++" workload from the Visual Studio Build Tools
   - Node.js LTS
   - Git
2. In GitHub: **Settings → Actions → Runners → New self-hosted runner → Windows x64**. Follow the download and `config.cmd` steps it shows, with these answers:
   - Runner group: Default
   - Name: `fuse-pc`
   - Labels: `fuse-pc`
   - Work folder: `_work`
   - **"Run as service?" N**: it must run as you, so it can open windows.
3. Make it start at login: in the runner's folder, make a shortcut to `run.cmd` and put it in `shell:startup` (Win+R, `shell:startup`).
4. Turn on the GitHub setting from **Safety** above.
5. Check it: in GitHub, **Actions → PC tests → Run workflow**. While it runs, a FUSE E2E window opens and is clicked through. Leave it alone until it closes.

## Starting it by hand

**Actions → PC tests → Run workflow.** Untick "Also run the update test" to skip that part.

## Turning it off

Settings → Actions → Runners → fuse-pc → Remove, then delete the runner's folder and the `shell:startup` shortcut.
