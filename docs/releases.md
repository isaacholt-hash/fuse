# Releases and auto-update

M1 step C3 (PL-06). FUSE updates itself from this repo's GitHub Releases.

## How a release happens

1. A PR merges to `main`. Docs-only changes don't trigger a release.
2. `.github/workflows/build.yml` (**Release**) drafts release `v0.1.<run number>`. The run number only goes up, so each release is newer than the last.
3. Windows (NSIS `.exe`) and Linux (AppImage, deb, rpm) are built with that version, and the updater bundles are signed with `TAURI_SIGNING_PRIVATE_KEY`.
4. `tauri-action` uploads the installers, their `.sig` files and `latest.json`. The release is then published and marked latest. If a build fails, the draft is deleted.

Releases go out one at a time, oldest first. You can also start one by hand: Actions → Release → Run workflow.

## How the app updates

- At startup and then every 6 hours, the app fetches `https://github.com/isaacholt-hash/fuse/releases/latest/download/latest.json`. If the version there is newer, the app downloads it in the background.
- When the download is done, a bar says "FUSE x.y.z is ready" with **Restart now** and **Later**. On Windows, the installer runs in passive mode (a progress bar only), and then FUSE restarts. Chats are untouched because the database lives in the app data folder.
- If the check fails (offline, GitHub down), it is logged to the console and retried at the next check. Nothing is shown.
- Settings shows the installed version.
- The repo must be **public**: the app downloads the update without any token. Isaac chose this on 2026-10-27.

## Signing

- **Update signing (free):** a minisign key pair made with `pnpm tauri signer generate`.
  - The public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
  - The private key is the `TAURI_SIGNING_PRIVATE_KEY` repo secret. It has no password, and Isaac keeps a copy at `~/.tauri/fuse.key` on HULK.
  - The app refuses any update that isn't signed with this key (`requireSignedVersion` also checks that the version is the one that was signed).
  - **If the private key is lost, installed copies can't update again**, and FUSE must be reinstalled by hand once.
- **Windows code signing (paid): not done.**
  - Without it, Windows shows "Windows protected your PC" when an installer is run by hand.
  - Updates installed by the app don't show that warning.
  - Revisit when FUSE has other users. Options include Azure Trusted Signing, or SignPath (free for open source).

## Verified

On HULK on 2026-10-27, with a throwaway key and a local server:
- A 0.1.0 AppImage found 0.1.1 and showed the bar.
- On Restart it replaced itself with the signed 0.1.1 file (checksum matched) and relaunched with no bar.

The Windows path is proven by the first real release.
