#!/usr/bin/env bash
# Everything that must pass before a PR is merged (except the screenshot).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pnpm lint
pnpm typecheck
pnpm test
bash scripts/secret-scan.sh
echo "All checks passed."
