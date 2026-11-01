# FUSE on HULK: deploying and running it

The web app and its runner (M10) run on HULK as one user service, `fuse-server.service`. It listens on `127.0.0.1:4100` only. Your tailnet reaches it through `tailscale serve` at `https://hulk.tailb7c872.ts.net:4100/`.

## First time (Isaac, once)

1. **Claim port 4100** in `~/hulkwatch/HOST_CONTRACT.md` §2. That file is edited in `E:/HustleGPT/hulkwatch`, as §5 says. Add this row:

   | Port | Project | Local bind | Tailnet route | URL |
   | --- | --- | --- | --- | --- |
   | 4100 | FUSE web app and runner (systemd user `fuse-server.service`) | `127.0.0.1:4100` | serve HTTPS `:4100` | https://hulk.tailb7c872.ts.net:4100/ |

   If the tailnet policy lists ports for hulk, as it does for 3100, add tcp 4100 there.

2. **Let your user services run while you're logged out.** Background runs need this. It needs sudo:

   ```bash
   sudo loginctl enable-linger daywalker
   ```

3. **Deploy** from the repo on HULK, on an up-to-date `main`:

   ```bash
   cd ~/fuse && git switch main && git pull && bash scripts/deploy-server.sh
   ```

   This builds the release server, the web app and the runner, and installs them into `~/.local/opt/fuse-server/<commit>/`. It writes `~/.config/systemd/user/fuse-server.service`, then enables and starts the service.

   Check it locally first. This should print `{"setUp":false,…}`:

   ```bash
   curl -s http://127.0.0.1:4100/api/auth/state
   ```

4. **Publish it on the tailnet.** This needs sudo and persists across reboots:

   ```bash
   sudo tailscale serve --bg --https=4100 http://127.0.0.1:4100
   ```

5. **Choose the passphrase straight away.** Open `https://hulk.tailb7c872.ts.net:4100/` on TCHALLA. The first visitor sets the passphrase, so don't leave it open. Use 12 or more characters and keep it in your password manager.

6. **Add your keys in the web app.** Go to Settings → Providers, as on the desktop. They're sealed with `systemd-creds` on HULK: the server's own keys, separate from your desktop's.

7. **Pair the desktop (TCHALLA).**
   - In the web app, open Settings → FUSE on HULK → Pair a device to get a code.
   - On the desktop, open Settings → HULK. Enter `https://hulk.tailb7c872.ts.net:4100` and the code.

8. **Git on HULK.** Handed-over runs push their `fuse/…` branch with HULK's own git credentials, using daywalker's ssh key or `gh auth setup-git`. Check them once:

   ```bash
   git ls-remote git@github.com:isaacholt-hash/fuse.git HEAD
   ```

## Updating

Run `bash scripts/deploy-server.sh` again. The service restarts. Runs that were going are saved as stopped, and Continue picks them up.

The last three builds are kept. To go back to one:

```bash
ln -sfn ~/.local/opt/fuse-server/<commit> ~/.local/opt/fuse-server/current
systemctl --user restart fuse-server
```

## Looking after it

- Logs:

  ```bash
  journalctl --user -u fuse-server -f
  ```

  The runner's lines start with `runner:`.

- Stop or start it:

  ```bash
  systemctl --user stop fuse-server
  systemctl --user start fuse-server
  ```

- **Data:** `~/.local/share/fuse-server`, which holds:
  - `config/`: the encrypted database and its backups
  - `data/`: attachments, the Python runtime, and HULK's clones of handed-over repositories under `work/`
  - `creds/`: keys and the database key, sealed to HULK
  - `auth.json`: the passphrase hash, sessions and devices

- **Backups:** this folder **isn't** in HULK's nightly backup (HOST_CONTRACT §8). The sealed credentials only open on HULK anyway. To keep the server's chats, use Settings → Data → Export from the web app now and then.

- **Lost the passphrase:** stop the service and delete `~/.local/share/fuse-server/auth.json`. On the next visit you set a new one, and paired devices must pair again. Chats and keys stay.
