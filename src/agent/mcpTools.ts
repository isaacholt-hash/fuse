// MCP tools as runs and chats offer them (M9 step 9, AG-02): a project's servers' tools, named
// for providers, with what FUSE needs to call each.
import type { McpCallResult, McpTool } from "@/mcp/api";
import type { ToolSpec } from "@/providers/types";

/** M9 step 9: what a run needs of MCP servers. */
export interface McpRunApi {
  /** The servers a project switched on. */
  forProject(projectId: string): Promise<{ id: string; name: string }[]>;
  tools(serverId: string): Promise<McpTool[]>;
  call(serverId: string, name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/** M9 step 9: an MCP tool as a run offers it. */
export interface McpOffered {
  serverId: string;
  serverName: string;
  tool: string;
  readOnly: boolean;
  destructive: boolean;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";

/**
 * A provider-safe name for a server's tool, `mcp__<server>__<tool>`, at most 64 characters and
 * unique in the run (a suffix when two would meet).
 */
export function mcpToolName(server: string, tool: string, taken: Set<string>): string {
  const base = `mcp__${slug(server).slice(0, 20)}__${slug(tool)}`.slice(0, 64);
  let name = base;
  for (let n = 2; taken.has(name); n++) {
    const suffix = `_${String(n)}`;
    name = base.slice(0, 64 - suffix.length) + suffix;
  }
  taken.add(name);
  return name;
}

/**
 * The tools of the servers a project switched on, as tool specs (non-strict: the schema is the
 * server's) and by name. With `readOnly`, only the tools a server marks read-only. A server that
 * won't start is skipped, and `onSkip` says why.
 */
export async function mcpToolsFor(
  mcp: McpRunApi,
  projectId: string,
  readOnly: boolean,
  onSkip: (server: string, error: string) => unknown,
): Promise<{ specs: ToolSpec[]; byName: Map<string, McpOffered> }> {
  const byName = new Map<string, McpOffered>();
  const specs: ToolSpec[] = [];
  const taken = new Set<string>();
  for (const server of await mcp.forProject(projectId)) {
    let tools: McpTool[];
    try {
      tools = await mcp.tools(server.id);
    } catch (e) {
      await onSkip(server.name, e instanceof Error ? e.message : String(e));
      continue;
    }
    for (const t of tools) {
      if (readOnly && !t.readOnly) continue;
      const name = mcpToolName(server.name, t.name, taken);
      byName.set(name, {
        serverId: server.id,
        serverName: server.name,
        tool: t.name,
        readOnly: t.readOnly,
        destructive: t.destructive === true,
      });
      specs.push({
        name,
        description: `[${server.name}, an MCP server] ${t.description}`.slice(0, 1024),
        schema: { type: "object", ...t.inputSchema },
        strict: false,
      });
    }
  }
  return { specs, byName };
}

/** A call's result as text (or a word on what it was) and its images, still base64. */
export function mcpOutput(r: McpCallResult): {
  text: string;
  images: { mime: string; data: string }[];
} {
  const text = r.parts.flatMap((p) => (p.kind === "text" && p.text ? [p.text] : [])).join("\n");
  const images = r.parts.flatMap((p) =>
    p.kind === "image" && p.data ? [{ mime: p.mime ?? "image/png", data: p.data }] : [],
  );
  return { text: text || (images.length ? "(an image)" : "(no output)"), images };
}
