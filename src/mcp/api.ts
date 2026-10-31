/**
 * MCP servers' Rust side (M9 step 8). Their variables' values go to the OS keychain and are
 * never read back here: the app only learns which are set.
 */
import { invoke } from "@tauri-apps/api/core";

/** M9 step 8: one tool a server offers; `readOnly` from its annotations, else it writes. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean | null;
}

/** A server that answered the handshake, and its tools. */
export interface McpHealth {
  serverName: string;
  serverVersion: string;
  protocol: string;
  tools: McpTool[];
}

/** M9 step 9: what a tool call returned, as text and images (base64). */
export interface McpCallResult {
  parts: {
    kind: "text" | "image";
    text: string | null;
    mime: string | null;
    data: string | null;
  }[];
  isError: boolean;
}

export interface McpApi {
  /** M9 step 9: its tools, starting it if it isn't running. */
  tools?(serverId: string): Promise<McpTool[]>;
  call?(serverId: string, name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** Starts the server (again), does the handshake and lists its tools. */
  check?(serverId: string): Promise<McpHealth>;
  /** M9 step 10: a remote server's sign-in (the system browser) and its tokens. */
  signIn?(serverId: string): Promise<void>;
  signOut?(serverId: string): Promise<void>;
  signedIn?(serverId: string): Promise<boolean>;
  stop?(serverId: string): Promise<void>;
  setSecret(serverId: string, name: string, value: string): Promise<void>;
  removeSecret(serverId: string, name: string): Promise<void>;
  /** Which of these variables have a value kept, in order. */
  secretStatus(serverId: string, names: string[]): Promise<boolean[]>;
}

export const tauriMcpApi: McpApi = {
  setSecret: (serverId, name, value) => invoke("mcp_secret_set", { serverId, name, value }),
  removeSecret: (serverId, name) => invoke("mcp_secret_delete", { serverId, name }),
  secretStatus: (serverId, names) => invoke<boolean[]>("mcp_secret_status", { serverId, names }),
  check: (serverId) => invoke<McpHealth>("mcp_check", { serverId }),
  tools: (serverId) => invoke<McpTool[]>("mcp_tools", { serverId }),
  call: (serverId, name, args) =>
    invoke<McpCallResult>("mcp_call", { serverId, name, arguments: args }),
  stop: (serverId) => invoke("mcp_stop", { serverId }),
  signIn: (serverId) => invoke("mcp_sign_in", { serverId }),
  signOut: (serverId) => invoke("mcp_sign_out", { serverId }),
  signedIn: (serverId) => invoke<boolean>("mcp_signed_in", { serverId }),
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
