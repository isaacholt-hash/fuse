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
