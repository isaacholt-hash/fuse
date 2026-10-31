# M8 step 16: `pnpm chat:live` and `pnpm work:live` with Isaac's keys, from his Windows
# environment. Their output never reaches the job log as it is: it goes to a file, which must
# pass the secret scan, and only the result lines (pass or fail, turns, cost per model) are shown.
$ErrorActionPreference = "Stop"
$summary = $env:GITHUB_STEP_SUMMARY

# A key set with SetEnvironmentVariable(..., "User") reaches the runner once it restarts.
foreach ($name in "FUSE_OPENAI_API_KEY", "FUSE_ANTHROPIC_API_KEY") {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    $user = [Environment]::GetEnvironmentVariable($name, "User")
    if ($user) { [Environment]::SetEnvironmentVariable($name, $user) }
  }
}
if (-not $env:FUSE_OPENAI_API_KEY -and -not $env:FUSE_ANTHROPIC_API_KEY) {
  throw "Neither key is set. See docs/windows-test-runner.md, Keys for the live-key button."
}

$failed = $false
$shown = @()
foreach ($suite in "chat:live", "work:live") {
  $log = Join-Path $env:RUNNER_TEMP "$($suite -replace ':', '-').log"
  & pnpm $suite *> $log
  $ok = $LASTEXITCODE -eq 0
  if (-not $ok) { $failed = $true }
  $text = Get-Content $log -Raw
  # The secret scan's pattern (scripts/secret-scan.sh), plus the keys themselves.
  $leak = $text -match 'sk-[A-Za-z0-9_-]{20,}|sk-ant-'
  foreach ($name in "FUSE_OPENAI_API_KEY", "FUSE_ANTHROPIC_API_KEY") {
    $key = [Environment]::GetEnvironmentVariable($name)
    if ($key -and $text.Contains($key)) { $leak = $true }
  }
  Remove-Item $log
  if ($leak) {
    $shown += "## $($suite)`n`nSomething that looks like a key was in the output, so none of it is shown."
    $failed = $true
    continue
  }
  # The tables (provider, pass, turns, cost) and the PASSED / FAILED and gate lines.
  $lines = $text -split "`r?`n" | Where-Object {
    $_ -match '[│┌└├]|^(PASSED|FAILED) |tasks passed|Tests +\d'
  }
  $shown += "## $($suite): $(if ($ok) { 'pass' } else { 'fail' })`n`n``````n$($lines -join "`n")`n``````"
}
$out = $shown -join "`n`n"
Write-Host $out
if ($summary) { Add-Content $summary $out }
if ($failed) { exit 1 }
