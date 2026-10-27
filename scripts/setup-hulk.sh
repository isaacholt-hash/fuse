#!/usr/bin/env bash
# One-time setup of HULK (Linux) for building FUSE with Tauri 2.
# Safe to re-run. Run from the repo root:  bash scripts/setup-hulk.sh
set -euo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

say "1/5 System packages (Tauri prerequisites + keychain library)"
if have apt-get; then
  sudo apt-get update
  sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
    libsecret-1-dev pkg-config git
elif have dnf; then
  sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file \
    libappindicator-gtk3-devel librsvg2-devel libxdo-devel libsecret-devel git
  sudo dnf group install -y "c-development" || sudo dnf groupinstall -y "Development Tools"
elif have pacman; then
  sudo pacman -S --needed --noconfirm webkit2gtk-4.1 base-devel curl wget file openssl \
    appmenu-gtk-module libappindicator-gtk3 librsvg xdotool libsecret git
else
  echo "Unknown package manager. Install the Tauri 2 Linux prerequisites by hand:"
  echo "https://v2.tauri.app/start/prerequisites/#linux"
  exit 1
fi

say "2/5 Rust (rustup)"
if ! have rustup; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"
rustup update stable

say "3/5 Node LTS (fnm) + pnpm"
if ! have fnm; then
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
  export PATH="$HOME/.local/share/fnm:$PATH"
fi
eval "$(fnm env --shell bash)"
fnm install --lts
fnm default lts-latest
corepack enable
corepack prepare pnpm@latest --activate

say "4/5 GitHub CLI (for opening PRs)"
if ! have gh; then
  echo "gh not found. Install it: https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
  echo "Then run: gh auth login"
else
  gh auth status || echo "Run: gh auth login"
fi

say "5/5 Keychain check"
if ! pgrep -x gnome-keyring-d >/dev/null && ! pgrep -x kwalletd5 >/dev/null && ! pgrep -x kwalletd6 >/dev/null; then
  echo "No Secret Service (gnome-keyring or KWallet) seems to be running."
  echo "FUSE stores API keys there. On a desktop session this is usually automatic;"
  echo "otherwise install gnome-keyring and log out/in."
fi

say "Versions"
rustc --version; cargo --version; node --version; pnpm --version
echo
echo "Done. Add this to ~/.bashrc if fnm isn't on your PATH in new shells:"
echo '  eval "$(fnm env --use-on-cd --shell bash)"'
