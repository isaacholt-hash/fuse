#!/usr/bin/env bash
# M17.3 Python artifact runs on the native server: real sandbox, a test-only system Python link,
# scripted replies, isolated storage, no provider calls.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source scripts/web-fixture-server.sh
mkdir -p e2e/screenshots/artifact-runs
pnpm exec vite build --mode e2e --outDir src-tauri/target/artifact-run-web
run_test_home="$(mktemp -d)"
# Only synthetic runtime metadata and a system-Python link in this throwaway server.
mkdir -p "$run_test_home/data/python-runtime/python/bin"
ln -s /usr/bin/python3 "$run_test_home/data/python-runtime/python/bin/python3"
printf '%s\n' '{"python":"system-test-only","release":"fixture","packages":[],"sizeBytes":0,"installedMs":0}' > "$run_test_home/data/python-runtime/python/fuse-runtime.json"
run_test_port="${FUSE_ARTIFACT_RUN_PORT:-4220}"
fixture_server_port_free "$run_test_port"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$run_test_port" --home "$run_test_home" --ui src-tauri/target/artifact-run-web --test-keys-in-memory \
  > e2e/screenshots/artifact-runs/server.log 2>&1 &
run_test_pid=$!
trap 'fixture_server_cleanup "$run_test_pid"' EXIT
fixture_server_ready "$run_test_pid" "$run_test_port"
FUSE_ARTIFACT_RUN_WEB_URL="http://127.0.0.1:$run_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/artifact-run-web.e2e.ts
if [[ -n "$(find "$run_test_home/data/skill-script-work" -mindepth 1 -print -quit 2>/dev/null)" ]]; then echo 'Artifact scratch was not removed'; exit 1; fi
