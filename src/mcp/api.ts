/**
 * MCP servers' Rust side (M9 step 8). Their variables' values go to the OS keychain and are
 * never read back here: the app only learns which are set.
 */
import { invoke } from "@tauri-apps/api/core";

export interface McpApi {
  setSecret(serverId: string, name: string, value: string): Promise<void>;
  removeSecret(serverId: string, name: string): Promise<void>;
  /** Which of these variables have a value kept, in order. */
  secretStatus(serverId: string, names: string[]): Promise<boolean[]>;
}

export const tauriMcpApi: McpApi = {
  setSecret: (serverId, name, value) => invoke("mcp_secret_set", { serverId, name, value }),
  removeSecret: (serverId, name) => invoke("mcp_secret_delete", { serverId, name }),
  secretStatus: (serverId, names) => invoke<boolean[]>("mcp_secret_status", { serverId, names }),
};

/**
 * A command line split into the program and its arguments, as a shell would for plain words,
 * "double" and 'single' quotes. No variables, globs or pipes: nothing runs through a shell.
 */
export function splitCommand(
  line: string,
): { command: string; args: string[] } | { error: string } {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return { error: "A quote isn't closed." };
  if (inWord) words.push(word);
  const [command, ...args] = words;
  if (!command) return { error: "Give the command that starts the server." };
  return { command, args };
}

/** The command line again, quoting what needs it, for showing. */
export const joinCommand = (command: string, args: string[]) =>
  [command, ...args]
    .map((w) => (/[\s"']/.test(w) || !w ? `"${w.replace(/"/g, "'")}"` : w))
    .join(" ");
