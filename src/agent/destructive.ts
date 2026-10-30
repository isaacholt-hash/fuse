// Commands that always ask, even when always-allowed or the run is in Auto-edit (CA-04): the ones
// that lose work or reach past the repository. Matched on the words, so `rm -rf build` and
// `git push --force origin main` both count. Better to ask once too often.

const RULES: { test: RegExp; why: string }[] = [
  {
    test: /(^|[;&|(]\s*|\s)rm\s+(-[a-z]*[rf][a-z]*\s+|--recursive|--force)/i,
    why: "deletes files",
  },
  { test: /\bgit\s+push\b[^;&|]*(\s-f\b|--force|--force-with-lease|\s\+\S)/i, why: "force-pushes" },
  { test: /\bgit\s+push\b/i, why: "pushes to a remote" },
  { test: /\bgit\s+reset\s+[^;&|]*--hard\b/i, why: "throws away uncommitted work" },
  { test: /\bgit\s+clean\b[^;&|]*\s-[a-z]*f/i, why: "deletes untracked files" },
  {
    test: /\bgit\s+(checkout|restore)\b[^;&|]*(\s--\s+\.|\s\.(\s|$))/i,
    why: "throws away changes",
  },
  { test: /\bgit\s+branch\s+[^;&|]*-D\b/, why: "deletes a branch" },
  { test: /\bgit\s+stash\s+(drop|clear)\b/i, why: "deletes stashed work" },
  { test: /(^|[;&|(]\s*|\s)sudo\b/i, why: "runs as administrator" },
  { test: /\b(mkfs(\.\w+)?|fdisk|diskpart)\b|(^|[;&|]\s*)format\s+[a-z]:/i, why: "formats a disk" },
  { test: /\bdd\s+[^;&|]*\bof=/i, why: "writes raw to a disk or file" },
  { test: /\b(shutdown|reboot|halt|poweroff)\b/i, why: "shuts the computer down" },
  { test: /\bchmod\s+-R\b|\bchown\s+-R\b/i, why: "changes permissions recursively" },
  {
    test: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^;&|]*\|\s*(sh|bash|zsh|iex|pwsh|powershell)\b/i,
    why: "runs a script from the internet",
  },
  { test: /\b(npm|pnpm|yarn|cargo)\s+publish\b/i, why: "publishes a package" },
  { test: /\b(del|rd|rmdir)\s+[^;&|]*\/s\b/i, why: "deletes files" },
  { test: /\bRemove-Item\b[^;&|]*-Recurse/i, why: "deletes files" },
  { test: />\s*\/dev\/(sd|nvme|disk)/i, why: "writes to a disk" },
];

/** Why this command always asks, or null when it's an ordinary one. */
export function destructiveReason(command: string): string | null {
  return RULES.find((r) => r.test.test(command))?.why ?? null;
}
