#!/usr/bin/env bash
# Real Git worktrees and background owner, synthetic model replies and in-memory secrets.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source scripts/web-fixture-server.sh
mkdir -p e2e/screenshots/parallel "$HOME/scratch"
parallel_test_home="$(mktemp -d)"
parallel_test_repo="$(mktemp -d "$HOME/scratch/fuse-parallel-fixture-XXXXXX")"
git -C "$parallel_test_repo" init --initial-branch=fixture >/dev/null
printf 'committed base\n' > "$parallel_test_repo/notes.txt"
git -C "$parallel_test_repo" add notes.txt
git -C "$parallel_test_repo" -c user.name='Recorded parallel' -c user.email=parallel@example.invalid commit -m 'Recorded base' >/dev/null
printf 'uncommitted parent\n' > "$parallel_test_repo/notes.txt"
VITE_E2E_PARALLEL=1 VITE_E2E_FOLDER="$parallel_test_repo" pnpm exec vite build --mode e2e --outDir src-tauri/target/parallel-web
pnpm exec vite build --config vite.parallel-fixture.config.ts
parallel_test_port="${FUSE_PARALLEL_PORT:-4217}"
fixture_server_port_free "$parallel_test_port"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" --port "$parallel_test_port" --home "$parallel_test_home" --ui src-tauri/target/parallel-web --runner "$(pwd)/src-tauri/target/parallel-runner-fixture/parallel-fixture.mjs" --node "$(command -v node)" --test-keys-in-memory > e2e/screenshots/parallel/server.log 2>&1 &
parallel_test_pid=$!
trap 'fixture_server_cleanup "$parallel_test_pid"' EXIT
fixture_server_ready "$parallel_test_pid" "$parallel_test_port"
FUSE_PARALLEL_FOLDER="$parallel_test_repo" FUSE_PARALLEL_WEB_URL="http://127.0.0.1:$parallel_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/parallel-web.e2e.ts
python3 - "$parallel_test_repo" <<'VERIFY'
from pathlib import Path
import subprocess,sys
repo=Path(sys.argv[1])
assert (repo/'notes.txt').read_text()=='uncommitted parent\n'
assert not (repo/'result.txt').exists()
assert subprocess.check_output(['git','-C',str(repo),'status','--porcelain=v1'],text=True).strip()=='M notes.txt'
assert subprocess.check_output(['git','-C',str(repo),'rev-list','--count','HEAD'],text=True).strip()=='1'
print('Parent retains its exact dirty file, index and original commit; reviewed integration uses a separate branch/worktree.')
VERIFY
