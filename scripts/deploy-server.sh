#!/usr/bin/env bash
# Builds FUSE on HULK (fuse-server, the web build and the runner) and installs it as the user
# service fuse-server.service (M10 step 10). Run it on HULK from the repo: bash scripts/deploy-server.sh
#
#   --no-restart   install the new build but leave the running service alone
#   --no-systemd   install the files only (for testing into a throwaway HOME)
#
# Installs into ~/.local/opt/fuse-server/<commit>/ with `current` pointing at it, writes
# ~/.config/systemd/user/fuse-server.service, and (re)starts it. The server keeps its data in
# ~/.local/share/fuse-server (database, keys sealed with systemd-creds, sign-in). It listens on
# 127.0.0.1:4100 only; the tailnet reaches it through `tailscale serve` (docs: M10 step 10).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

RESTART=1
SYSTEMD=1
for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    --no-systemd) SYSTEMD=0 ;;
    *) echo "Unknown option $arg" >&2; exit 2 ;;
  esac
done

PORT=4100
COMMIT="$(git rev-parse --short HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree has changes; commit or stash them first, so the build matches $COMMIT." >&2
  exit 1
fi
# The runner needs a Node that doesn't move: fnm's per-shell path does, so resolve the real one.
NODE="$(readlink -f "$(command -v node)")"
"$NODE" --version >/dev/null

echo "Building $COMMIT…"
pnpm install --frozen-lockfile
pnpm build:web
pnpm build:runner
cargo build --release --manifest-path src-tauri/Cargo.toml --features server --bin fuse-server

# FUSE_DEPLOY_ROOT: install somewhere else (testing, with --no-systemd).
ROOT="${FUSE_DEPLOY_ROOT:-$HOME/.local/opt/fuse-server}"
DEST="$ROOT/$COMMIT"
rm -rf "$DEST.tmp"
mkdir -p "$DEST.tmp"
cp src-tauri/target/release/fuse-server "$DEST.tmp/"
cp -r dist-web "$DEST.tmp/ui"
cp dist-runner/runner.mjs "$DEST.tmp/"
rm -rf "$DEST"
mv "$DEST.tmp" "$DEST"
ln -sfn "$DEST" "$ROOT/current"
# Keep the last three builds, for going back.
ls -1dt "$ROOT"/*/ | grep -v '/current/$' | tail -n +4 | xargs -r rm -rf

UNIT="$HOME/.config/systemd/user/fuse-server.service"
mkdir -p "$(dirname "$UNIT")"
cat >"$UNIT" <<EOF
# Written by fuse/scripts/deploy-server.sh ($COMMIT). FUSE on HULK: the web app and its runner.
[Unit]
Description=FUSE on HULK (web app and runner)
After=network-online.target

[Service]
ExecStart=%h/.local/opt/fuse-server/current/fuse-server --port $PORT --ui %h/.local/opt/fuse-server/current/ui --runner %h/.local/opt/fuse-server/current/runner.mjs --node $NODE
Environment=PATH=$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
# The runner gets 15 s to save its runs as stopped.
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
if [[ "$SYSTEMD" == 0 ]]; then
  echo "Installed $COMMIT in $DEST (no systemd)."
  exit 0
fi
systemctl --user daemon-reload
systemctl --user enable fuse-server.service >/dev/null
if [[ "$RESTART" == 1 ]]; then
  systemctl --user restart fuse-server.service
  sleep 2
  systemctl --user --no-pager --lines=5 status fuse-server.service || true
fi
echo "Installed $COMMIT in $DEST."
echo "Local check: curl -s http://127.0.0.1:$PORT/api/auth/state"
