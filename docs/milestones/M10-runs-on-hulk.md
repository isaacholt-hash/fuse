# M10 — Runs on HULK (P2, part 3)

**Goal:** FUSE runs without you watching. The same app is served from HULK as a self-hosted, single-user web app (PL-03, PL-02). Runs started there, or handed over from the desktop, keep going with the laptop closed (CA-15). You follow them and answer their approvals from any signed-in browser (the core of CA-16), and scheduled tasks start runs on a clock (AG-07). It builds on M6's runs, M8's sandbox, M9's tools and injection guard, and M5's export and restore.

**Done when:** the recorded runs-on-HULK benchmark (step 10) passes:
- A run carries on after its browser session closes.
- An approval is answered from a second session.
- A Code run handed over from a desktop fixture pushes its branch.
- A scheduled task fires.
- An interrupted run continues.

Then Isaac deploys with the step 10 kit and does the live check: hand over a Code run from TCHALLA, close the laptop, and find the pushed branch afterwards.

**Out of scope:**
- Sync between the desktop and server databases (PL-04).
- More than one user, or access from outside the tailnet.
- Mobile apps (PL-14).
- The local model on the server.
- Remote MCP servers that need OAuth from the web app (greyed, with the reason).
- Web push.
- Dictation (VI-01) and deep research (FK-12).

## Decisions (2026-10-31; Isaac approved the plan and asked for M10 to be built unattended)

- **Two processes, one codebase.**
  - `fuse-server` is a Rust binary in the same crate, Linux only, behind a `server` feature. It uses axum. It serves the built UI, handles sign-in, and exposes the app's commands at `POST /api/<command>` from an allowlist. Streams go over a WebSocket.
  - A Node **runner** is the same TypeScript run loop (`src/agent/run.ts`), bundled for Node. It runs runs headless and talks to fuse-server through the same API. fuse-server starts it and restarts it if it dies.
  - The browser and the runner both go through one `invoke` seam (`src/platform`), so nothing is written twice.
- **Keys on the server** are `systemd-creds --user` encrypted credentials: the OS's own store, tied to the host. It's a second key store behind the same trait; the desktop keychain is unchanged. Isaac enters keys in the web app's Settings, as on the desktop. The server database's SQLCipher key is held the same way.
- **Access:**
  - fuse-server listens only on 127.0.0.1. Isaac publishes it to the tailnet with `tailscale serve` (HTTPS).
  - Sign-in is a single-user passphrase set on the first visit, hashed with argon2id, giving an HttpOnly, Secure, SameSite=Strict session cookie.
  - Every request's Origin is checked, and failed sign-ins are rate-limited.
  - A desktop pairs with a one-time code that becomes a per-device token in its keychain. It can be revoked from Settings → Devices.
- **Separate databases.** The server has its own encrypted database. A handover sends the project as a PL-12 export, restored on the server with stable ids. No sync until PL-04.
- **What can be handed over:**
  - Code runs on a repository with a git remote: the server clones or fetches into its own workspace, works on `fuse/<run-id>`, and pushes that branch.
  - Chats, and Work runs in folders that exist on HULK.
  - Folders that live only on the laptop say "Only on this computer" (PL-02).
- **Unattended approvals.**
  - A run that reaches an approval waits as "Waiting for you", and any signed-in browser can answer it.
  - The cost cap and M9's injection flags apply as before.
  - Pushing is a send, so it asks unless the project already allows it.
- **Restarts.** If the server restarts, runs that were going are marked Interrupted and keep their steps; Continue picks them up. Nothing reruns on its own.
- **New crates:** axum, tower-http (static files) and argon2. Each is pinned to a release at least two weeks old, with its date.
- **Build mode for this milestone:** Claude builds the steps in order, merging each once checks and CI are green, without stopping between steps. Claude stops only for something Isaac must do, a decision not covered here, or a CI failure that won't clear.

## Steps (one PR each, in order)

- [x] **0. M10 plan.** This file, the requirements notes (§3, §11, §11b, §18), and CLAUDE.md pointed here.
- [x] **1. Frontend platform seam.**
  - `src/platform` holds `invoke` and `channel`, implemented by Tauri or by HTTP and WebSocket.
  - Every api module goes through it.
  - A test checks that nothing outside `src/platform` imports `@tauri-apps/api/core`.
  - The desktop behaves the same.
- [x] **2. Rust core without Tauri.**
  - A `Ctx` (data folder, key store, database, run and process registries) and an `EventSink` trait replace `State`, `AppHandle` and `Channel` inside the command bodies.
  - Tauri commands become thin wrappers. No behaviour change.
- [x] **3. fuse-server.**
  - The `server` feature and `src-tauri/src/bin/fuse-server.rs`.
  - It serves the UI and has the command allowlist (desktop-only commands are refused). Streams use a WebSocket.
  - Data lives in `~/.local/share/fuse-server`, and keys in systemd-creds.
  - Tests cover the allowlist, the key store and the egress policy. CI builds the server on Linux.
- [x] **4. Sign-in and devices.**
  - Passphrase setup and sign-in, sessions, the Origin check, the rate limit and sign-out.
  - Device pairing codes and tokens, with Settings → Devices and Revoke.
  - Threat model: the web app on HULK.
  - Done in the server; the sign-in and Devices screens come with the web build (step 5).
- [x] **5. Web UI.**
  - `pnpm build:web` builds the same app on the HTTP platform.
  - OS-only features are greyed with a reason (PL-02): hotkey, updater, Windows Hello. The native folder dialog becomes a picker under the server's allowed folders.
  - Settings shows the server version (PL-06).
  - Screenshots at desktop width and at 390 px.
- [ ] **6. Runs on HULK (CA-15, part 1).**
  - The runner, started and watched by fuse-server.
  - A run started in the web app runs in the runner, so closing the tab doesn't stop it. The page follows the run's stored steps live.
  - "Waiting for you" approvals can be answered from any session. Stop works. Interrupted runs continue.
  - A Runs list shows going, waiting, done and failed.
  - Part 1 done (the runner):
    - `run_requests`, `run_approvals` and `run_live` (migration 0050, `src/storage/runQueue.ts`) are how a page and the runner talk, through the server's database.
    - `src/runner` is the same chat run loop as the desktop's, built into one Node file by `pnpm build:runner`. It takes requests oldest first, parks each approval as a question any page can answer, saves the streaming text twice a second, and stops a run when a page asks. After a restart it marks runs that were going as stopped (Continue picks them up), fails requests it had taken, and counts open questions as no.
    - fuse-server starts it with `--runner dist-runner/runner.mjs` (and `--node`), with its own device token made at each start (not listed or revocable) and only PATH, HOME, LANG and TZ in its environment, so it has no keys. It starts it again 5 s after it exits, and on SIGTERM lets it save its runs as stopped before the server stops.
    - Checked for real on HULK: a request from a page went through the runner and the run to the provider transport (no key on the throwaway server, so it ended with "No Anthropic key yet") and the answer was saved; SIGTERM stopped both cleanly.
    - Changed from the plan: the page follows a run by reading its stored steps and `run_live` every second, rather than over the WebSocket. It's simpler, and it works the same from any page.
  - Part 2 (next): the web app asks for runs instead of running them, shows waiting questions and the Runs list.
- [ ] **7. Handover from the desktop (CA-15, part 2).**
  - Settings → HULK: the address and a pairing code.
  - "Run on HULK" in the Code composer and on a stopped run. It sends the project's export, the repo's remote and base branch, and the prompt and mode. The server works on `fuse/<run-id>` and pushes it.
  - The desktop shows the run's status and opens it in the browser.
  - Part 1 done (the plumbing):
    - The desktop pairs with HULK in Rust (`src-tauri/src/hulk.rs`): the address must be https (or this computer, for tests), and the device token from the pairing code goes in the keychain, never to the webview. `hulk_invoke` calls only `db_open`, `db_select`, `db_execute` and `key_status` on HULK, and `hulk_put_file` uploads the project's export.
    - `src/handover/handover.ts` checks the repository first (an `origin` remote, a branch checked out, nothing uncommitted or unpushed, since HULK works from what's on origin), uploads the project's PL-12 export, and asks HULK's runner to start a Code run on a new branch with the handover's details.
    - The runner restores the project (same ids; what's already there is kept), has the server clone or fetch the repository into its own copy (`repo_clone`, server only: https, ssh or `user@host:path` remotes, or a repository under the server's home; a copy with changes left in it is refused), and runs in a new chat in the project with only that copy as its folder. When the run is done on its branch, it asks to push it, as a send, and says what happened.
  - Part 2 (next): Settings → HULK and "Run on HULK" in the desktop's Code composer, with the run's status.
- [ ] **8. Notify and follow (CA-16 core).**
  - When a run finishes, fails or starts waiting, the web Runs list shows a badge.
  - A paired desktop shows a system notification.
- [ ] **9. Scheduled tasks (AG-07).**
  - Per project: a saved prompt with mode, tools and cost cap, run once at a time, or daily or weekly at a time, by the runner.
  - The result lands in a thread with a notice; a failure reports its last step.
  - On the server only (greyed on the desktop until sync). Tests use a fake clock.
- [ ] **10. Runs-on-HULK benchmark and deploy kit.**
  - The recorded e2e above, against a throwaway fuse-server with provider fixtures and no keys.
  - `scripts/deploy-server.sh` and the `fuse-server.service` user unit, plus the exact commands Isaac runs: enabling linger, `tailscale serve`, the first passphrase, and entering keys in the web Settings.
  - Part 2 done (the deploy kit): `scripts/deploy-server.sh` builds and installs a release into `~/.local/opt/fuse-server/<commit>/` and writes the user unit (127.0.0.1:4100); `docs/hulk-server.md` has Isaac's first-time steps, updating and looking after it. Tested into a scratch folder: the installed build served the UI and started the runner.

## Notes
