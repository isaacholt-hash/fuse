#!/usr/bin/env bash
# M17.2 writing canvas against the native server; scripted replies, isolated storage, no provider calls.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source scripts/web-fixture-server.sh
mkdir -p e2e/screenshots/canvas
pnpm exec vite build --mode e2e --outDir src-tauri/target/canvas-web
canvas_test_home="$(mktemp -d)"
canvas_test_port="${FUSE_CANVAS_PORT:-4219}"
fixture_server_port_free "$canvas_test_port"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$canvas_test_port" --home "$canvas_test_home" --ui src-tauri/target/canvas-web --test-keys-in-memory \
  > e2e/screenshots/canvas/server.log 2>&1 &
canvas_test_pid=$!
trap 'fixture_server_cleanup "$canvas_test_pid"' EXIT
fixture_server_ready "$canvas_test_pid" "$canvas_test_port"
FUSE_CANVAS_WEB_URL="http://127.0.0.1:$canvas_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/canvas-web.e2e.ts
