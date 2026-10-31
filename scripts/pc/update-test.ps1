# M8 step 15: the real update test, on Isaac's PC (docs/windows-test-runner.md).
# Installs the release before the newest, starts it, lets it find and download the newest, presses
# "Restart now" through Windows UI Automation, and checks the newest is what runs afterwards.
# FUSE must not be open: the test is skipped if it is, so it never closes Isaac's work.
$ErrorActionPreference = "Stop"
$repo = "isaacholt-hash/fuse"
$summary = $env:GITHUB_STEP_SUMMARY

function Say($line) {
  Write-Host $line
  if ($summary) { [IO.File]::AppendAllText($summary, "$line`n") }
}

# The click-through tests' build is fuse.exe too; only an installed FUSE counts as open.
$open = Get-Process -Name "FUSE" -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike "*\target\debug\*" }
if ($open) {
  Say "Update test skipped: FUSE was open. Close it and run the workflow again to include it."
  exit 0
}

$releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=10"
$withSetup = @($releases | Where-Object { -not $_.draft -and -not $_.prerelease -and ($_.assets | Where-Object { $_.name -like "*_x64-setup.exe" }) })
if ($withSetup.Count -lt 2) { throw "Need two releases with a Windows installer." }
$newest = $withSetup[0].tag_name.TrimStart("v")
$previous = $withSetup[1]
$old = $previous.tag_name.TrimStart("v")
Say "Update test: $old to $newest"

$asset = $previous.assets | Where-Object { $_.name -like "*_x64-setup.exe" } | Select-Object -First 1
$setup = Join-Path $env:RUNNER_TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $setup
Start-Process $setup -ArgumentList "/S" -Wait

function Installed {
  $keys = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue
  $fuse = $keys | Get-ItemProperty | Where-Object { $_.DisplayName -eq "FUSE" } | Select-Object -First 1
  if (-not $fuse) { throw "FUSE isn't installed." }
  return $fuse
}
$entry = Installed
if ($entry.DisplayVersion -ne $old) { throw "Installed $($entry.DisplayVersion), not $old." }
# Tauri's installer records where it put FUSE; older entries only have the icon's path.
$dir = if ($entry.InstallLocation) { $entry.InstallLocation.Trim('"') } else { Split-Path ($entry.DisplayIcon -replace '"|,\d+$', '') }
$exe = Get-ChildItem $dir -Filter "*.exe" | Where-Object { $_.Name -notlike "uninstall*" } | Select-Object -First 1 -ExpandProperty FullName
Start-Process $exe

# The app checks for an update when it starts and downloads it; then the bar offers "Restart now".
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$byName = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty, "Restart now")
$restart = $null
$until = (Get-Date).AddMinutes(5)
while (-not $restart) {
  if ((Get-Date) -gt $until) { throw "No ""Restart now"" button within 5 minutes." }
  Start-Sleep -Seconds 3
  $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty, "FUSE")))
  if ($window) { $restart = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $byName) }
}
Say "Found the update bar; pressing Restart now."
$restart.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()

# Windows quits the app to run the installer, which starts it again.
$until = (Get-Date).AddMinutes(5)
for (;;) {
  Start-Sleep -Seconds 5
  $now = (Installed).DisplayVersion
  $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
  if ($now -eq $newest -and $running) { break }
  if ((Get-Date) -gt $until) { throw "After 5 minutes: installed $now, running: $([bool]$running)." }
}
$version = (Get-Item $exe).VersionInfo.ProductVersion
Say "Update test passed: FUSE $newest is installed and running (exe version $version)."
Get-Process | Where-Object { $_.Path -eq $exe } | Stop-Process
