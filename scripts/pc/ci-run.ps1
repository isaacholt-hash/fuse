# M8 step 15: the id of CI's run on this commit (a push to main), waiting for it to finish, so the
# PC tests can download its test build ("e2e-app") instead of compiling one.
$ErrorActionPreference = "Stop"
$headers = @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = "application/vnd.github+json" }
$url = "https://api.github.com/repos/$env:GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?head_sha=$env:SHA&event=push"
$until = (Get-Date).AddMinutes(45)
for (;;) {
  $run = (Invoke-RestMethod $url -Headers $headers).workflow_runs | Select-Object -First 1
  if ($run -and $run.status -eq "completed") { break }
  if ((Get-Date) -gt $until) { throw "CI on $env:SHA didn't finish within 45 minutes." }
  Start-Sleep -Seconds 30
}
Write-Host "CI run $($run.id): $($run.conclusion)"
[IO.File]::AppendAllText($env:GITHUB_OUTPUT, "run=$($run.id)`n")
