import { Laptop, Server } from "lucide-react";
import { Greyed } from "./primitives";

/**
 * M10 step 16 (CH-19): what a new Code or Work session needs before it starts: its project,
 * where it runs, and its cost cap. The rest (kind, mode, branch, model) sits in the composer
 * under it. A choice that can't be made here stays visible, with why (PL-02).
 */
export function NewSessionBar({
  projects,
  projectId,
  onProject,
  where,
  onWhere,
  whereReasons,
  capMicroUsd,
  defaultCapMicroUsd,
  onCap,
  noFolder,
}: {
  projects: { id: string; name: string }[];
  projectId: string | null;
  onProject: (projectId: string | null) => void;
  where: "local" | "hulk";
  onWhere: (where: "local" | "hulk") => void;
  /** Why each place can't be picked; null when it can. */
  whereReasons: { local: string | null; hulk: string | null };
  /** This session's own cap; null uses the project's, then FUSE's. */
  capMicroUsd: number | null;
  defaultCapMicroUsd: number;
  onCap: (capMicroUsd: number | null) => void;
  /** No folder to work in yet: what to do about it. */
  noFolder: string | null;
}) {
  const places = [
    { id: "local" as const, label: "This computer", icon: <Laptop className="size-3.5" /> },
    { id: "hulk" as const, label: "HULK", icon: <Server className="size-3.5" /> },
  ];
  const reason = whereReasons[where === "local" ? "hulk" : "local"];
  return (
    <div
      data-new-session
      aria-label="New session"
      role="group"
      className="mx-auto mb-2 flex w-full max-w-[780px] flex-wrap items-center gap-x-4 gap-y-2 px-8 text-xs max-[800px]:px-5"
    >
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Project</span>
        <select
          aria-label="Project or repository"
          className="h-8 max-w-[200px] rounded-lg border border-input bg-background px-2 text-xs"
          value={projectId ?? ""}
          onChange={(e) => {
            onProject(e.target.value || null);
          }}
        >
          <option value="">No project (pick a folder)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Where</span>
        <div role="group" aria-label="Where it runs" className="flex rounded-lg border p-0.5">
          {places.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={where === p.id}
              disabled={whereReasons[p.id] !== null}
              title={whereReasons[p.id] ?? undefined}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 disabled:opacity-50 ${where === p.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => {
                onWhere(p.id);
              }}
            >
              {p.icon}
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Cost cap $</span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          inputMode="decimal"
          aria-label="Cost cap"
          className="h-8 w-20 rounded-lg border border-input bg-background px-2 text-right text-xs tabular-nums"
          placeholder={(defaultCapMicroUsd / 1_000_000).toFixed(2)}
          defaultValue={capMicroUsd === null ? "" : (capMicroUsd / 1_000_000).toFixed(2)}
          key={`cap-${String(capMicroUsd)}`}
          onBlur={(e) => {
            const n = Number(e.target.value);
            const micro =
              e.target.value.trim() === "" || !Number.isFinite(n) || n <= 0
                ? null
                : Math.round(n * 1_000_000);
            if (micro !== capMicroUsd) onCap(micro);
          }}
        />
      </label>
      {reason && <Greyed>{reason}</Greyed>}
      {noFolder && <Greyed>{noFolder}</Greyed>}
    </div>
  );
}
