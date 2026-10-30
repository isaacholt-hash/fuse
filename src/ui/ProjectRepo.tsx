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
}

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
