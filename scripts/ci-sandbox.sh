#!/usr/bin/env bash
# CI-only: exercise the real OS sandbox on an ephemeral GitHub-hosted Ubuntu runner.
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != Linux ]]; then
  echo 'This sandbox setup is restricted to ephemeral GitHub-hosted Linux CI.' >&2
  exit 1
fi
# Ubuntu 24.04 restricts capabilities in unconfined user namespaces. Grant userns only to
# the installed bubblewrap executable, following Ubuntu's documented unconfined profile.
# https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions
# Do not disable the system-wide restriction, or change an installed FUSE/HULK host.
sandbox_apparmor_enabled=N
if [[ -r /sys/module/apparmor/parameters/enabled ]]; then
  read -r sandbox_apparmor_enabled < /sys/module/apparmor/parameters/enabled
fi
if [[ "$sandbox_apparmor_enabled" == Y ]]; then
  sudo tee /etc/apparmor.d/fuse-ci-bwrap >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
/usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
  sudo apparmor_parser -r /etc/apparmor.d/fuse-ci-bwrap
fi
# No presence-only pass or silent skip: the exact namespace/capability setup must start.
bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL \
  --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp -- /bin/true
