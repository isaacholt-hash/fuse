#!/usr/bin/env bash
# Shared production components; synthetic provider availability, isolated native storage, no provider calls.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p e2e/screenshots/skills
pnpm exec vite build --mode e2e --outDir src-tauri/target/skills-web
skills_test_home="$(mktemp -d)"
skills_test_port="${FUSE_SKILLS_PORT:-4214}"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$skills_test_port" --home "$skills_test_home" --ui src-tauri/target/skills-web --test-keys-in-memory \
  > e2e/screenshots/skills/server.log 2>&1 &
skills_test_pid=$!
trap 'kill "$skills_test_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$skills_test_port/api/auth/state" >/dev/null && break; sleep 0.5; done
FUSE_SKILLS_WEB_URL="http://127.0.0.1:$skills_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/skills-web.e2e.ts
