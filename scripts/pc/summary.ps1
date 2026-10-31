# M8 step 15: the PC tests' results in the run summary, and an issue when one failed.
$ErrorActionPreference = "Stop"
$rows = "| Check | Result |`n| --- | --- |`n| Click-through tests | $env:E2E |`n| Update test | $env:UPDATE |`n| Local model benchmark | $env:LOCAL |"
[IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, "`n$rows`n")
Write-Host $rows
if (@($env:E2E, $env:UPDATE, $env:LOCAL) -contains "failure") {
  $headers = @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = "application/vnd.github+json" }
  $run = "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"
  $issue = @{
    title = "PC tests failed on $($env:GITHUB_SHA.Substring(0, 7))"
    body  = "$rows`n`nRun: $run"
  } | ConvertTo-Json
  Invoke-RestMethod -Method Post "https://api.github.com/repos/$env:GITHUB_REPOSITORY/issues" -Headers $headers -Body $issue -ContentType "application/json" | Out-Null
  exit 1
}
