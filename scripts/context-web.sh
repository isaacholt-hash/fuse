#!/usr/bin/env bash
# Shared production components; synthetic provider availability, isolated native storage, no provider calls.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source scripts/web-fixture-server.sh
mkdir -p e2e/screenshots/context
pnpm exec vite build --mode e2e --outDir src-tauri/target/context-web
context_test_home="$(mktemp -d)"
context_test_port="${FUSE_CONTEXT_PORT:-4218}"
fixture_server_port_free "$context_test_port"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$context_test_port" --home "$context_test_home" --ui src-tauri/target/context-web --test-keys-in-memory \
  > e2e/screenshots/context/server.log 2>&1 &
context_test_pid=$!
trap 'fixture_server_cleanup "$context_test_pid"' EXIT
fixture_server_ready "$context_test_pid" "$context_test_port"
FUSE_CONTEXT_WEB_URL="http://127.0.0.1:$context_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/context-web.e2e.ts
