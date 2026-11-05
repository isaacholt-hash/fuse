#!/usr/bin/env bash
# Real UI/native storage/Node owner, synthetic providers/sources; never production data or secrets.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p e2e/screenshots/research
VITE_E2E_RESEARCH=1 pnpm exec vite build --mode e2e --outDir src-tauri/target/research-web
pnpm exec vite build --config vite.research-fixture.config.ts
research_test_home="$(mktemp -d)"
research_test_port="${FUSE_RESEARCH_PORT:-4210}"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$research_test_port" --home "$research_test_home" --ui src-tauri/target/research-web \
  --runner "$(pwd)/src-tauri/target/research-runner-fixture/research-fixture.mjs" --node "$(command -v node)" \
  --test-keys-in-memory > e2e/screenshots/research/server.log 2>&1 &
research_test_pid=$!
trap 'kill "$research_test_pid" 2>/dev/null || true; rm -rf "$research_test_home"' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$research_test_port/api/auth/state" >/dev/null && break; sleep 0.5; done
FUSE_RESEARCH_WEB_URL="http://127.0.0.1:$research_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/research-web.e2e.ts
