/**
 * PL-02: why a feature of the desktop app is greyed in the web app on HULK (M10 step 5). Each
 * control stays visible, disabled, with its reason beside it (`<Greyed>` in ./primitives).
 */
export const WEB_REASONS = {
  /** M10 step 16: the web app's sessions run on HULK. */
  runHere: "The web app runs on HULK: sessions run there, not on this computer.",
  hotkey:
    "A global shortcut needs the desktop app: a browser tab can't listen for keys in other apps.",
  update: "Updated with the server",
  appLock:
    "The web app is behind the server's passphrase instead, so there's no separate app lock or Windows Hello here.",
  local:
    "The local model runs only in the desktop app, on your own computer. The web app uses cloud models for housekeeping.",
  windowsSandbox:
    "This switch is for the desktop app on Windows. On HULK, commands always run in its Linux sandbox.",
  open: "Opening a file in its app, or in its folder, needs the desktop app: this file is on HULK.",
  mcpSignIn: "Remote MCP servers that need sign-in aren't available in the web app yet.",
  restore: "Restoring a backup restarts the app, so it's done on HULK itself, not from a browser.",
  textSize: "Use your browser's zoom instead (Ctrl + and Ctrl −).",
} as const;
