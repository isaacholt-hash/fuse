import { FileDiff, FolderGit2, GitBranch, Laptop, Server } from "lucide-react";

const MODES = {
  plan: "Read-only",
  ask: "Ask first",
  auto_edit: "Can edit files",
} as const;

/**
 * M10 step 16 (CH-19): one line under a session's header: where it runs, its folders, the branch
 * its latest run is on, what its runs may do (changeable here), and the Files panel. Money lives
 * in the ledger: the thread total at its head, "cap left" under the composer.
 */
export function SessionStrip({
  where,
  folders,
  branch,
  mode,
  onMode,
  files,
  filesOpen,
  onFiles,
}: {
  where: "local" | "hulk";
  folders: string[];
  branch: string | null;
  mode: keyof typeof MODES;
  onMode: (mode: keyof typeof MODES) => void;
  /** How many files its runs changed and artifacts it made. */
  files: number;
  filesOpen: boolean;
  onFiles: () => void;
}) {
  return (
    <div
      aria-label="Session"
      role="group"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-6 py-2 text-[12px] text-muted-foreground max-[800px]:px-5 max-[560px]:gap-x-3"
    >
      <span className="flex items-center gap-1.5">
        {where === "hulk" ? <Server className="size-3.5" /> : <Laptop className="size-3.5" />}
        Runs on{" "}
        <b className="font-medium text-foreground">{where === "hulk" ? "HULK" : "this computer"}</b>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <FolderGit2 className="size-3.5 shrink-0" />
        <b className="truncate font-medium text-foreground">
          {folders.length > 0 ? folders.join(", ") : "No folder"}
        </b>
        <span className="text-border">·</span>
        <GitBranch className="size-3.5" />
        <span className="font-mono text-[11px]">{branch ?? "current branch"}</span>
      </span>
      <label className="flex items-center gap-1.5">
        {/* The select names itself; on a phone the word gives its room to the cap. */}
        <span className="max-[560px]:sr-only">Mode</span>
        <select
          aria-label="What this session's runs may do"
          className="h-6 rounded-[4px] border-0 bg-muted px-1.5 text-[12px] font-medium text-foreground dark:scheme-dark"
          value={mode}
          onChange={(e) => {
            const v = e.target.value;
            onMode(v === "plan" ? "plan" : v === "auto_edit" ? "auto_edit" : "ask");
          }}
        >
          {(Object.keys(MODES) as (keyof typeof MODES)[]).map((m) => (
            <option key={m} value={m}>
              {MODES[m]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-pressed={filesOpen}
        className={`ml-auto flex items-center gap-1.5 rounded px-1.5 py-0.5 ${filesOpen ? "bg-muted text-foreground" : "hover:bg-muted"}`}
        onClick={onFiles}
      >
        <FileDiff className="size-3.5" />
        Files{files > 0 ? ` (${String(files)})` : ""}
      </button>
    </div>
  );
}
