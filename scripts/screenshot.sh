#!/usr/bin/env bash
# Starts the app on a virtual display (HULK is headless), screenshots the FUSE window, stops the app.
# Usage: bash scripts/screenshot.sh [output.png]
#   FUSE_VIEW=settings   open on a given screen (dev builds only)
#   FUSE_BEFORE_SHOT=cmd  run cmd (e.g. xdotool clicks/typing) right before the screenshot
# Needs: xvfb, imagemagick, x11-utils, gnome-keyring (installed on HULK 2026-10-26).
# Runs in a private D-Bus session with a throwaway, unlocked keyring in a temp dir,
# so it never touches the real login keyring, and with a throwaway database.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
OUT="$(realpath -m "${1:-src-tauri/target/screenshots/fuse.png}")"
mkdir -p "$(dirname "$OUT")"
LOG="$(dirname "$OUT")/tauri-dev.log"

if [[ -z "${FUSE_IN_XVFB:-}" ]]; then
  FUSE_IN_XVFB=1 exec xvfb-run -a -s "-screen 0 1280x800x24" bash "$0" "$OUT"
fi
if [[ -z "${FUSE_IN_DBUS:-}" ]]; then
  FUSE_IN_DBUS=1 exec dbus-run-session -- bash "$0" "$OUT"
fi
KEYRING_HOME="$(mktemp -d)"
printf 'throwaway' | XDG_DATA_HOME="$KEYRING_HOME" gnome-keyring-daemon --unlock --components=secrets >/dev/null
export VITE_FUSE_VIEW="${FUSE_VIEW:-}"
# The app's database and attachment files go in the same temp dir, so screenshots never touch real data.
export XDG_CONFIG_HOME="$KEYRING_HOME/config" XDG_DATA_HOME="$KEYRING_HOME/data"

# WebKitGTK renders black under Xvfb without these.
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
setsid pnpm tauri dev >"$LOG" 2>&1 &
PG=$!
cleanup() {
  kill -TERM -- "-$PG" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$PG" 2>/dev/null || true
  rm -rf "$KEYRING_HOME"
}
trap cleanup EXIT

for _ in $(seq 1 300); do
  if xwininfo -root -tree 2>/dev/null | grep -q '"FUSE"'; then break; fi
  if ! kill -0 "$PG" 2>/dev/null; then echo "App exited early. Log: $LOG"; tail -20 "$LOG"; exit 1; fi
  sleep 1
done
if ! xwininfo -root -tree | grep -q '"FUSE"'; then echo "No FUSE window after 300 s. Log: $LOG"; exit 1; fi
sleep "${FUSE_SHOT_DELAY:-8}"
if [[ -n "${FUSE_BEFORE_SHOT:-}" ]]; then bash -c "$FUSE_BEFORE_SHOT"; fi
import -window root "$OUT"
echo "Screenshot: $OUT"
