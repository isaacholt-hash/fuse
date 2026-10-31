# Click-through tests (M8 step 14)

FUSE is driven like a person would use it, with real mouse clicks, typing and keyboard shortcuts, against a **test build**. The test starts the app and drives its WebView2 over the DevTools Protocol, on a port only the test build opens (`--remote-debugging-port=9222`, localhost).

The usual tool, tauri-driver with Edge's msedgedriver, doesn't work: from WebView2 133 on, msedgedriver crashes the WebView it launches ([WebView2Feedback#5415](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5415)). GitHub's runners have 156.

## The test build

`pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json` builds it.

- The front end is built with `vite build --mode e2e`. Only in that mode does `src/main.tsx` load `src/e2e/deps.ts`, which swaps in:
  - scripted Anthropic turns, through the real adapter, with no network
  - a fake saved key
  - an update that is always "ready" (9.9.9)
  - a folder picker that returns `VITE_E2E_FOLDER`
- Its window opens the DevTools port. A normal build never does.
- It's a separate app, "FUSE E2E" (`com.isaacholt.fuse.e2e`), with its own data folder. It never touches FUSE's chats or settings.
- CI checks that a release bundle never contains the test code (`fuse-e2e-scripted-build`). The tests check that the window they drive is the test build before they click anything.

## What it covers

`e2e/app.e2e.ts`, one screenshot per step in `e2e/screenshots/`:

1. Send a message and see its cost.
2. Switch models (Ctrl+K), and see the switch marked in the chat.
3. The update bar shows, and Later hides it (M7 F1).
4. Settings opens and closes (Ctrl+,).
5. The composer at 640, 900 and 1400 px wide: the main controls and Send stay inside its box (F4).
6. A Work run on a test folder, sandboxed, running checks 2, 3 and 5 of step 9's checklist:
   - a write inside the folder works
   - a write to Documents is denied
   - `>NUL` works, skipped on Windows Server, which denies NUL to sandboxed apps

## Running it

CI runs it on every PR (the "Windows click-through" job) and uploads the screenshots. On Windows by hand:

```
$env:VITE_E2E_FOLDER = "C:\fuse-e2e"
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json
$env:FUSE_E2E_APP = "$PWD\src-tauri\target\debug\fuse.exe"
pnpm e2e
```
