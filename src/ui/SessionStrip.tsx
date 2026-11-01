import { FileDiff, FolderGit2, GitBranch, Laptop, Server } from "lucide-react";
import { money } from "./format";

const MODES = {
  plan: "Read-only",
  ask: "Ask first",
  auto_edit: "Can edit files",
} as const;

/**
 * M10 step 16 (CH-19): one line under a session's header: where it runs, its folders, the branch
 * its latest run is on, what its runs may do (changeable here), what it has spent against its
 * cap, and the Files panel.
 */
export function SessionStrip({
  where,
  folders,
  branch,
  mode,
  onMode,
  spentMicro,
  capMicro,
  files,
  filesOpen,
  onFiles,
}: {
  where: "local" | "hulk";
  folders: string[];
  branch: string | null;
  mode: keyof typeof MODES;
  onMode: (mode: keyof typeof MODES) => void;
  spentMicro: number;
  capMicro: number;
  /** How many files its runs changed and artifacts it made. */
  files: number;
  filesOpen: boolean;
  onFiles: () => void;
}) {
  return (
    <div
      aria-label="Session"
      role="group"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-6 py-1.5 text-[11px] text-muted-foreground"
    >
      <span className="flex items-center gap-1.5">
        {where === "hulk" ? <Server className="size-3" /> : <Laptop className="size-3" />}
        {where === "hulk" ? "On HULK" : "On this computer"}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <FolderGit2 className="size-3 shrink-0" />
        <span className="truncate">{folders.length > 0 ? folders.join(", ") : "No folder"}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <GitBranch className="size-3" />
        <span className="font-mono">{branch ?? "current branch"}</span>
      </span>
      <label className="flex items-center gap-1.5">
        <span className="sr-only">What its runs may do</span>
        <select
          aria-label="What this session's runs may do"
          className="h-6 rounded border border-input bg-background px-1 text-[11px]"
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
      <span className="font-mono tabular-nums" aria-label="Spent of cap">
        {money(spentMicro)} of {money(capMicro)}
      </span>
      <button
        type="button"
        aria-pressed={filesOpen}
        className={`ml-auto flex items-center gap-1.5 rounded px-1.5 py-0.5 ${filesOpen ? "bg-muted text-foreground" : "hover:bg-muted"}`}
        onClick={onFiles}
      >
        <FileDiff className="size-3" />
        Files{files > 0 ? ` (${String(files)})` : ""}
      </button>
    </div>
  );
}
