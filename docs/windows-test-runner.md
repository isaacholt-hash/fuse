# Test runner on Isaac's Windows PC

M8 step 15 runs FUSE's tests on Isaac's real Windows desktop through a GitHub Actions self-hosted runner. Isaac installs it once, in about five minutes. No job uses it until step 15 is merged, so it can be set up before then.

## Install

1. On GitHub, open the fuse repo, then **Settings → Actions → Runners → New self-hosted runner**, and pick **Windows** and **x64**. The page shows the commands, with a token that lasts an hour.
2. Open PowerShell as yourself (**not** as administrator) and run the page's **Download** commands. They create `C:\actions-runner`.
3. Run the page's **Configure** command (`.\config.cmd --url … --token …`). Answer:
   - Runner group: press Enter.
   - Name: `fuse-windows`.
   - Additional labels: `fuse-windows`.
   - Work folder: press Enter.
   - **Run as service? N.** A service can't open the app's window or take screenshots.
4. Start it whenever you log in:

   ```powershell
   $a = New-ScheduledTaskAction -Execute "C:\actions-runner\run.cmd" -WorkingDirectory "C:\actions-runner"
   $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   Register-ScheduledTask -TaskName "FUSE test runner" -Action $a -Trigger $t -RunLevel Limited
   Start-ScheduledTask -TaskName "FUSE test runner"
   ```

5. Back on GitHub, **Settings → Actions → General → Approval for running fork pull request workflows from contributors**: choose **Require approval for all external contributors**. The runner's jobs never run on pull requests anyway; this is a second lock.

The runner shows as **Idle** on the Runners page when it's ready.

## What it runs

`.github/workflows/pc-tests.yml` runs after each release from a push to main, and when you start it from **Actions → PC tests → Run workflow**. It never runs on pull requests, and a check on the job itself refuses any other trigger. It runs:

1. **The click-through tests** (step 14) on your real desktop, including check 5 (`>NUL`), which GitHub's Windows Server can't run. They use the separate test build, "FUSE E2E", with its own data folder, so your chats and settings aren't touched. They make `C:\fuse-e2e`, and check that `Documents\escape.txt` never appears.
2. **The update test** (`scripts/pc/update-test.ps1`). It installs the release before the newest over your FUSE, starts it, and waits for the update bar. It presses **Restart now** through Windows UI Automation, then checks the newest is installed and running.
   - **It skips itself if FUSE is open**, so it never closes your work. Close FUSE, or start the workflow by hand when you're away, to include it.
   - Your chats stay, as with any update, and it ends on the newest release.
   - Starting it by hand, you can untick "Also run the update test".
3. **`pnpm local:bench`**, when a local model is installed.

The results are in the run's summary. A failure opens an issue and never blocks merging. Screenshots of the click-through tests are uploaded as `pc-e2e-screenshots`.

## Keys for the live-key button (step 16)

Only needed for the button. Type each key at the prompt, so it never lands in PowerShell's history:

```powershell
$k = Read-Host "OpenAI key" -AsSecureString
[Environment]::SetEnvironmentVariable("FUSE_OPENAI_API_KEY", [Net.NetworkCredential]::new("", $k).Password, "User")
$k = Read-Host "Anthropic key" -AsSecureString
[Environment]::SetEnvironmentVariable("FUSE_ANTHROPIC_API_KEY", [Net.NetworkCredential]::new("", $k).Password, "User")
Remove-Variable k
```

Then restart the runner so it picks them up: `Stop-ScheduledTask "FUSE test runner"; Start-ScheduledTask "FUSE test runner"`.

## Good to know

- Jobs run only while the PC is on and you're logged in. Otherwise they wait in the queue, and GitHub drops them after 24 hours.
- A test may open FUSE windows on your screen for a minute or two. Leave them alone until the job finishes.
- To stop it: `Disable-ScheduledTask "FUSE test runner"`. To remove it: `.\config.cmd remove` in `C:\actions-runner`, with the removal token from the Runners page.
