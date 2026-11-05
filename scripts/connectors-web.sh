#!/usr/bin/env bash
# Shared UI and native storage only; the e2e build substitutes synthetic public account states.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p e2e/screenshots/connectors
pnpm exec vite build --mode e2e --outDir src-tauri/target/connectors-web
connectors_test_home="$(mktemp -d)"
connectors_test_port="${FUSE_CONNECTORS_PORT:-4212}"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$connectors_test_port" --home "$connectors_test_home" --ui src-tauri/target/connectors-web \
  --test-keys-in-memory > e2e/screenshots/connectors/server.log 2>&1 &
connectors_test_pid=$!
trap 'kill "$connectors_test_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$connectors_test_port/api/auth/state" >/dev/null && break; sleep 0.5; done
FUSE_CONNECTORS_WEB_URL="http://127.0.0.1:$connectors_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/connectors-web.e2e.ts
