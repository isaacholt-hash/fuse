#!/usr/bin/env bash
# Actual native package isolation using a test-only system Python, never the installed app/runtime.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p e2e/screenshots/skill-scripts
script_test_home="$(mktemp -d)"
mkdir -p "$HOME/scratch"
script_test_repo="$(mktemp -d "$HOME/scratch/fuse-script-fixture-XXXXXX")"
VITE_E2E_SKILL_SCRIPT=1 VITE_E2E_FOLDER="$script_test_repo" pnpm exec vite build --mode e2e --outDir src-tauri/target/skill-script-web
pnpm exec vite build --config vite.skill-script-fixture.config.ts
# Install only synthetic runtime metadata and a system-Python link in this throwaway server.
mkdir -p "$script_test_home/data/python-runtime/python/bin"
ln -s /usr/bin/python3 "$script_test_home/data/python-runtime/python/bin/python3"
printf '%s\n' '{"python":"system-test-only","release":"fixture","packages":[],"sizeBytes":0,"installedMs":0}' > "$script_test_home/data/python-runtime/python/fuse-runtime.json"
script_test_port="${FUSE_SKILL_SCRIPT_PORT:-4214}"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" --port "$script_test_port" --home "$script_test_home" --ui src-tauri/target/skill-script-web --runner "$(pwd)/src-tauri/target/skill-script-runner-fixture/skill-script-fixture.mjs" --node "$(command -v node)" --test-keys-in-memory > e2e/screenshots/skill-scripts/server.log 2>&1 &
script_test_pid=$!
trap 'kill "$script_test_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$script_test_port/api/auth/state" >/dev/null && break; sleep 0.5; done
FUSE_SKILL_SCRIPT_FOLDER="$script_test_repo" FUSE_SKILL_SCRIPT_WEB_URL="http://127.0.0.1:$script_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/skill-script-web.e2e.ts
if [[ -n "$(find "$script_test_repo" -mindepth 1 -print -quit)" ]]; then echo 'Skill modified its host folder'; exit 1; fi
if [[ -n "$(find "$script_test_home/data/skill-script-work" -mindepth 1 -print -quit 2>/dev/null)" ]]; then echo 'Skill scratch was not removed'; exit 1; fi
