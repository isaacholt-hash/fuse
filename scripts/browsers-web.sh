#!/usr/bin/env bash
# M19.1 shared web app in Chromium, Firefox and WebKit (Playwright) against the native server.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source scripts/web-fixture-server.sh
mkdir -p e2e/screenshots/browsers
pnpm exec vite build --mode e2e --outDir src-tauri/target/browsers-web
browsers_test_home="$(mktemp -d)"
browsers_test_port="${FUSE_BROWSERS_PORT:-4222}"
fixture_server_port_free "$browsers_test_port"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$browsers_test_port" --home "$browsers_test_home" --ui src-tauri/target/browsers-web --test-keys-in-memory --test-plain-http-cookie \
  > e2e/screenshots/browsers/server.log 2>&1 &
browsers_test_pid=$!
trap 'fixture_server_cleanup "$browsers_test_pid"' EXIT
fixture_server_ready "$browsers_test_pid" "$browsers_test_port"
FUSE_BROWSERS_URL="http://127.0.0.1:$browsers_test_port/" pnpm exec playwright test -c playwright.config.ts
