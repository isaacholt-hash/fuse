#!/usr/bin/env bash
# Exits 0 only if every check on PR <n> finished with SUCCESS. The merge gate for ship-step.
# Reads GitHub's JSON rather than grepping text: a text grep let a failed check through once.
# Usage: bash scripts/ci-green.sh <pr-number> [owner/repo]
set -euo pipefail
pr="$1"
repo="${2:-isaacholt-hash/fuse}"
verdict="$(gh pr view "$pr" -R "$repo" --json statusCheckRollup --jq '
  .statusCheckRollup as $c
  | if ($c | length) > 0 and all($c[]; .conclusion == "SUCCESS") then "green"
    else "not green: " + ([$c[] | "\(.name)=\(.conclusion // .status)"] | join(", "))
    end')"
echo "PR #$pr: $verdict"
[[ "$verdict" == "green" ]]
