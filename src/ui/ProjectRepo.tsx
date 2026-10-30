import { FolderGit2 } from "lucide-react";

export interface ProjectRepoProps {
  /** The linked folder, or null. */
  root: string | null;
  readSecrets: boolean;
  /** A line under the folder: "Git repository", or why linking failed. */
  note: string | null;
  onLink: () => void;
  onUnlink: () => void;
  onReadSecrets: (allow: boolean) => void;
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
 * Project settings → Repository (CA-01): the folder the coding agent works in. It can only reach
 * files inside it, never ignored ones, and secret-looking files only if allowed here.
 */
export function ProjectRepoSection({
  root,
  readSecrets,
  note,
  onLink,
  onUnlink,
  onReadSecrets,
  runMode = "ask",
  onRunMode,
  commands = [],
  onDisallow,
}: ProjectRepoProps) {
  return (
    <section aria-label="Project repository">
      <div className="mb-1 flex items-center gap-2">
        <FolderGit2 className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-medium">Repository</h3>
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground">
        The folder the coding agent works in. It can only reach files inside it, and skips anything
        the repository&apos;s .gitignore leaves out.
      </p>
      {root ? (
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5" title={root}>
              {root}
            </code>
            <button type="button" className={buttonClass} onClick={onLink}>
              Change
            </button>
            <button type="button" className={buttonClass} onClick={onUnlink}>
              Unlink
            </button>
          </div>
          {note && <p className="text-[10px] text-muted-foreground">{note}</p>}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={readSecrets}
              onChange={(e) => {
                onReadSecrets(e.target.checked);
              }}
            />
            Let the agent read files that look like secrets (.env, keys)
          </label>
          {onRunMode && (
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
      ) : (
        <div className="space-y-1">
          <button type="button" className={buttonClass} onClick={onLink}>
            Link a folder…
          </button>
          {note && <p className="text-[10px] text-amber-700 dark:text-amber-400">{note}</p>}
        </div>
      )}
    </section>
  );
}
