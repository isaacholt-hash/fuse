#!/usr/bin/env bash
# Real shared UI/native Git capture/Node owner, isolated repository and synthetic model replies.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p e2e/screenshots/review
review_test_home="$(mktemp -d "${TMPDIR:-/tmp}/fuse-review-web-XXXXXX")"
# A granted server folder must be under the service user's home, as in the normal web app.
mkdir -p "$HOME/scratch"
review_test_repo="$(mktemp -d "$HOME/scratch/fuse-review-fixture-XXXXXX")"
git -C "$review_test_repo" init --initial-branch=fixture >/dev/null
printf 'export const ratio = (num, den) => num / den;\n' > "$review_test_repo/ratio.ts"
git -C "$review_test_repo" add ratio.ts
git -C "$review_test_repo" -c user.name='Recorded review' -c user.email=review@example.invalid commit -m 'Recorded base' >/dev/null
printf 'export const ratio = (num, den) => num / (den - 1);\n' > "$review_test_repo/ratio.ts"
VITE_E2E_REVIEW_SEED=1 VITE_E2E_FOLDER="$review_test_repo" pnpm exec vite build --mode e2e --outDir src-tauri/target/review-web
pnpm exec vite build --config vite.review-fixture.config.ts
review_test_port="${FUSE_REVIEW_PORT:-4214}"
FUSE_SERVER_TEST=1 "${FUSE_SERVER_BIN:-src-tauri/target/debug/fuse-server}" \
  --port "$review_test_port" --home "$review_test_home" --ui src-tauri/target/review-web \
  --runner "$(pwd)/src-tauri/target/review-runner-fixture/review-fixture.mjs" --node "$(command -v node)" \
  --test-keys-in-memory > e2e/screenshots/review/server.log 2>&1 &
review_test_pid=$!
trap 'kill "$review_test_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$review_test_port/api/auth/state" >/dev/null && break; sleep 0.5; done
FUSE_REVIEW_WEB_URL="http://127.0.0.1:$review_test_port/" pnpm exec vitest run --config e2e/vitest.config.ts e2e/review-web.e2e.ts

python3 - "$review_test_repo" <<'VERIFY'
from pathlib import Path
import subprocess,sys
repo=Path(sys.argv[1])
assert (repo/'ratio.ts').read_text()=='export const ratio = (num, den) => num / (den - 1);\n'
status=subprocess.check_output(['git','-C',str(repo),'status','--porcelain=v1'],text=True)
assert status.strip()=='M ratio.ts',status
print('Recorded repository retains exactly its original dirty file; no writes/commits from review.')
VERIFY
