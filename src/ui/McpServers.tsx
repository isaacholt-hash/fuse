// Settings → MCP servers (M9 step 8, AG-02): add a local command or a remote URL, its variables
// (kept in the OS keychain), and whether a local one may use the network. Projects switch them
// on (step 9).
import { useId, useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface McpServerView {
  id: string;
  name: string;
  /** "Local: npx -y …" or "Remote: https://…". */
  detail: string;
  local: boolean;
  network: boolean;
  /** "GITHUB_TOKEN (set)", "API_KEY (not set)". */
  variables: { name: string; set: boolean }[];
}

export interface McpServerDraft {
  name: string;
  transport: "stdio" | "http";
  /** stdio: the whole command line. */
  commandLine: string;
  url: string;
  variables: { name: string; value: string }[];
  network: boolean;
}

const emptyDraft = (): McpServerDraft => ({
  name: "",
  transport: "stdio",
  commandLine: "",
  url: "",
  variables: [],
  network: false,
});

const field = "w-full rounded-md border bg-background px-2 py-1 text-xs";

export function McpServersSection({
  servers,
  onAdd,
  onRemove,
  onNetwork,
}: {
  servers: McpServerView[];
  /** Resolves to a problem to show, or null once it's added. */
  onAdd: (draft: McpServerDraft) => Promise<string | null>;
  onRemove: (id: string) => void;
  onNetwork: (id: string, on: boolean) => void;
}) {
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { name: useId(), cmd: useId(), url: useId() };
  const set = (patch: Partial<McpServerDraft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  return (
    <section className="mt-8 border-t pt-6" aria-label="MCP servers">
      <div className="mb-1 flex items-center gap-2">
        <Plug className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">MCP servers</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Tools from other programs and services, through the Model Context Protocol. A project
        switches a server on for its chats and runs. Local servers run in the sandbox; their
        variables (tokens, keys) are kept in this computer&apos;s keychain, never in FUSE&apos;s
        data or sent to a model.
      </p>
      <ul className="mb-3 space-y-2 text-[11px]">
        {servers.length === 0 && <li className="text-muted-foreground">No servers yet.</li>}
        {servers.map((s) => (
          <li key={s.id} className="rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{s.name}</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {s.detail}
              </span>
              <button
                type="button"
                className="ml-auto text-[11px] text-destructive hover:underline"
                onClick={() => {
                  onRemove(s.id);
                }}
              >
                Remove
              </button>
            </div>
            {s.variables.length > 0 && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                Variables:{" "}
                {s.variables.map((v) => `${v.name} (${v.set ? "set" : "not set"})`).join(", ")}
              </p>
            )}
            {s.local && (
              <label className="mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={s.network}
                  onChange={(e) => {
                    onNetwork(s.id, e.target.checked);
                  }}
                />
                Let it use the network (it runs sandboxed without it otherwise)
              </label>
            )}
          </li>
        ))}
      </ul>
      {draft ? (
        <form
          aria-label="Add an MCP server"
          className="space-y-2 rounded-lg border p-3 text-[11px]"
          onSubmit={(e) => {
            e.preventDefault();
            void onAdd(draft).then((p) => {
              setProblem(p);
              if (!p) setDraft(null);
            });
          }}
        >
          <div>
            <label htmlFor={ids.name} className="mb-0.5 block">
              Name
            </label>
            <input
              id={ids.name}
              className={field}
              value={draft.name}
              onChange={(e) => {
                set({ name: e.target.value });
              }}
            />
          </div>
          <div className="flex gap-3">
            {(["stdio", "http"] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="mcp-transport"
                  checked={draft.transport === t}
                  onChange={() => {
                    set({ transport: t });
                  }}
                />
                {t === "stdio" ? "A command on this computer" : "A remote server (URL)"}
              </label>
            ))}
          </div>
          {draft.transport === "stdio" ? (
            <div>
              <label htmlFor={ids.cmd} className="mb-0.5 block">
                Command
              </label>
              <input
                id={ids.cmd}
                className={`${field} font-mono`}
                placeholder="npx -y @modelcontextprotocol/server-memory"
                value={draft.commandLine}
                onChange={(e) => {
                  set({ commandLine: e.target.value });
                }}
              />
            </div>
          ) : (
            <div>
              <label htmlFor={ids.url} className="mb-0.5 block">
                Address
              </label>
              <input
                id={ids.url}
                className={`${field} font-mono`}
                placeholder="https://example.com/mcp"
                value={draft.url}
                onChange={(e) => {
                  set({ url: e.target.value });
                }}
              />
            </div>
          )}
          <fieldset>
            <legend className="mb-0.5">Variables (kept in the keychain)</legend>
            {draft.variables.map((v, i) => (
              <div key={i} className="mb-1 flex gap-1">
                <input
                  aria-label={`Variable ${String(i + 1)} name`}
                  className={`${field} font-mono`}
                  placeholder="NAME"
                  value={v.name}
                  onChange={(e) => {
                    set({
                      variables: draft.variables.map((x, j) =>
                        j === i ? { ...x, name: e.target.value } : x,
                      ),
                    });
                  }}
                />
                <input
                  aria-label={`Variable ${String(i + 1)} value`}
                  type="password"
                  autoComplete="off"
                  className={field}
                  placeholder="value"
                  value={v.value}
                  onChange={(e) => {
                    set({
                      variables: draft.variables.map((x, j) =>
                        j === i ? { ...x, value: e.target.value } : x,
                      ),
                    });
                  }}
                />
              </div>
            ))}
            <button
              type="button"
              className="text-[11px] hover:underline"
              onClick={() => {
                set({ variables: [...draft.variables, { name: "", value: "" }] });
              }}
            >
              Add a variable
            </button>
          </fieldset>
          {draft.transport === "stdio" && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.network}
                onChange={(e) => {
                  set({ network: e.target.checked });
                }}
              />
              Let it use the network
            </label>
          )}
          {problem && <p className="text-destructive">{problem}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-7 text-xs">
              Add server
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setDraft(null);
                setProblem(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            setDraft(emptyDraft());
          }}
        >
          Add a server
        </Button>
      )}
    </section>
  );
}
