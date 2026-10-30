import { FolderGit2 } from "lucide-react";

export interface ProjectFolderView {
  id: string;
  path: string;
  readSecrets: boolean;
  /** WF-07: sandboxed commands here may use the network. */
  network?: boolean;
}

export interface ProjectRepoProps {
  /** WF-02: the folders this project's chats work in, first one first. */
  folders: ProjectFolderView[];
  /** A line under the list: what the last added folder is, or why adding failed. */
  note: string | null;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onReadSecrets: (id: string, allow: boolean) => void;
  onNetwork?: (id: string, allow: boolean) => void;
  /** CA-04: the mode its coding runs start in. */
  runMode?: "plan" | "ask" | "auto_edit";
  onRunMode?: (mode: "plan" | "ask" | "auto_edit") => void;
  /** Commands its runs may run without asking. */
  commands?: string[];
  onDisallow?: (command: string) => void;
}

const MODES = {
  plan: "Read-only: list, read and search",
  ask: "Ask first: each edit and command waits for you",
  auto_edit: "Can edit files: edits go ahead, commands ask",
} as const;

const buttonClass = "h-7 rounded-lg border border-input px-2 text-xs hover:bg-muted";

/**
 * Project settings → Folders (CA-01, WF-02): the folders this project's chats work in. FUSE can
 * only reach files inside them, never ones their .gitignore leaves out, and secret-looking files
 * only where allowed here.
 */
export function ProjectRepoSection({
  folders,
  note,
  onAdd,
  onRemove,
  onReadSecrets,
  onNetwork,
  runMode = "ask",
  onRunMode,
  commands = [],
  onDisallow,
}: ProjectRepoProps) {
  return (
    <section aria-label="Project folders">
      <div className="mb-1 flex items-center gap-2">
        <FolderGit2 className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-medium">Folders</h3>
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground">
        Folders this project&apos;s chats can work in with Code. FUSE can only reach files inside
        them, and skips anything a folder&apos;s .gitignore leaves out.
      </p>
      <div className="space-y-2 text-xs">
        {folders.length > 0 && (
          <ul className="space-y-2">
            {folders.map((f) => (
              <li key={f.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <code
                    className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5"
                    title={f.path}
                  >
                    {f.path}
                  </code>
                  <button
                    type="button"
                    className={buttonClass}
                    aria-label={`Remove ${f.path}`}
                    onClick={() => {
                      onRemove(f.id);
                    }}
                  >
                    Remove
                  </button>
                </div>
                <label className="flex items-center gap-2 text-[11px]">
                  <input
                    type="checkbox"
                    checked={f.readSecrets}
                    onChange={(e) => {
                      onReadSecrets(f.id, e.target.checked);
                    }}
                  />
                  Let it read files that look like secrets (.env, keys) here
                </label>
                {onNetwork && (
                  <label className="flex items-center gap-2 text-[11px]">
                    <input
                      type="checkbox"
                      checked={f.network ?? false}
                      onChange={(e) => {
                        onNetwork(f.id, e.target.checked);
                      }}
                    />
                    Let commands here use the network (they run sandboxed without it otherwise)
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}
        <button type="button" className={buttonClass} onClick={onAdd}>
          {folders.length === 0 ? "Link a folder…" : "Add a folder…"}
        </button>
        {note && <p className="text-[10px] text-muted-foreground">{note}</p>}
        {folders.length > 0 && onRunMode && (
          <label className="flex items-center gap-2">
            <span className="shrink-0">Coding runs start as</span>
            <select
              aria-label="Coding runs start as"
              className="h-7 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-xs"
              value={runMode}
              onChange={(e) => {
                const v = e.target.value;
                onRunMode(v === "plan" ? "plan" : v === "auto_edit" ? "auto_edit" : "ask");
              }}
            >
              {(Object.keys(MODES) as (keyof typeof MODES)[]).map((m) => (
                <option key={m} value={m}>
                  {MODES[m]}
                </option>
              ))}
            </select>
          </label>
        )}
        {commands.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] text-muted-foreground">
              Always allowed here (destructive commands still ask):
            </p>
            <ul className="space-y-1">
              {commands.map((c) => (
                <li key={c} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5">
                    {c}
                  </code>
                  {onDisallow && (
                    <button
                      type="button"
                      className={buttonClass}
                      aria-label={`Stop always allowing ${c}`}
                      onClick={() => {
                        onDisallow(c);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
