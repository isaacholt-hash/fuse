#!/usr/bin/env bash
# M18.3 provider reports in the shared web app: native commands, no keys, no provider calls.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source scripts/web-fixture-server.sh
mkdir -p e2e/screenshots/reports
pnpm exec vite build --mode e2e --outDir src-tauri/target/reports-web
reports_test_home="$(mktemp -d)"
reports_test_port="${FUSE_REPORTS_PORT:-4221}"
fixture_server_port_free "$reports_test_port"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$reports_test_port" --home "$reports_test_home" --ui src-tauri/target/reports-web --test-keys-in-memory \
  > e2e/screenshots/reports/server.log 2>&1 &
reports_test_pid=$!
trap 'fixture_server_cleanup "$reports_test_pid"' EXIT
fixture_server_ready "$reports_test_pid" "$reports_test_port"
FUSE_REPORTS_WEB_URL="http://127.0.0.1:$reports_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/reports-web.e2e.ts
