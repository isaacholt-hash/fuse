#!/usr/bin/env bash
# Fails if anything that looks like an API key is tracked in git.
# Lines that only quote the scan pattern itself (CLAUDE.md, AGENTS.md, this file) are ignored.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PATTERN='sk-[A-Za-z0-9_-]{20,}|sk-ant-'
hits=$(git grep -nE "$PATTERN" -- . ':!pnpm-lock.yaml' | grep -vF 'sk-[A-Za-z0-9_-]{20,}' || true)
if [[ -n "$hits" ]]; then
  echo "Secret scan FAILED: possible API key(s):"
  # Show file:line only, never the matched text.
  echo "$hits" | cut -d: -f1,2
  exit 1
fi
echo "Secret scan passed."
