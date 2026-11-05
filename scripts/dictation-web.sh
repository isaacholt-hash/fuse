#!/usr/bin/env bash
# Synthetic dictation UI; never a live microphone, provider call or production database.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p e2e/screenshots/dictation
pnpm exec vite build --mode e2e --outDir src-tauri/target/dictation-web
dictation_test_home="$(mktemp -d)"
dictation_test_port="${FUSE_DICTATION_PORT:-4209}"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$dictation_test_port" --home "$dictation_test_home" \
  --ui src-tauri/target/dictation-web --test-keys-in-memory \
  > e2e/screenshots/dictation/server.log 2>&1 &
dictation_test_pid=$!
trap 'kill "$dictation_test_pid" 2>/dev/null || true; rm -rf "$dictation_test_home"' EXIT
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$dictation_test_port/api/auth/state" >/dev/null && break
  sleep 0.5
done
FUSE_DICTATION_WEB_URL="http://127.0.0.1:$dictation_test_port/" \
  pnpm exec vitest run --config e2e/vitest.config.ts e2e/dictation-web.e2e.ts
