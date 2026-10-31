# Click-through tests (M8 step 14)

FUSE is driven like a person would use it: typing, clicking, keyboard shortcuts. The tests use [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/) and Edge's WebDriver against a **test build**.

## The test build

`pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json` builds it.

- The front end is built with `vite build --mode e2e`. Only in that mode does `src/main.tsx` load `src/e2e/deps.ts`, which swaps in:
  - scripted Anthropic turns, through the real adapter, with no network
  - a fake saved key
  - an update that is always "ready" (9.9.9)
  - a folder picker that returns `VITE_E2E_FOLDER`
- It's a separate app, "FUSE E2E" (`com.isaacholt.fuse.e2e`), with its own data folder. It never touches FUSE's chats or settings.
- CI checks that a release bundle never contains the test code (`fuse-e2e-scripted-build`). The tests check that the window they drive is the test build before they click anything.

## What it covers

`e2e/app.e2e.ts`, one screenshot per step in `e2e/screenshots/`:

1. Send a message and see its cost.
2. Switch models (Ctrl+K), and see the switch marked in the chat.
3. The update bar shows, and Later hides it (M7 F1).
4. Settings opens and closes (Ctrl+,).
5. A Work run on a test folder, sandboxed, running checks 2, 3 and 5 of step 9's checklist:
   - a write inside the folder works
   - a write to Documents is denied
   - `>NUL` works, skipped on Windows Server, which denies NUL to sandboxed apps

## Running it

CI runs it on every PR (the "Windows click-through" job) and uploads the screenshots. On Windows by hand:

```
cargo install tauri-driver --version 2.1.0 --locked
# msedgedriver.exe matching your WebView2 version, from https://developer.microsoft.com/microsoft-edge/tools/webdriver/
$env:VITE_E2E_FOLDER = "C:\fuse-e2e"
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json
$env:FUSE_E2E_APP = "$PWD\src-tauri\target\debug\fuse.exe"
$env:FUSE_E2E_NATIVE_DRIVER = "C:\path\to\msedgedriver.exe"
pnpm e2e
```
