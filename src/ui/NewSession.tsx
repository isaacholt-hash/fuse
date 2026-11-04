import { usePanelActive, usePanelLeave } from "./panelActivity";
import { Check, ChevronDown, FolderOpen, Laptop, Server, SlidersHorizontal } from "lucide-react";
import { Popover } from "radix-ui";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { money } from "./format";

type Mode = "plan" | "ask" | "auto_edit";
const MODE_NAMES: Record<Mode, string> = {
  plan: "Read-only",
  ask: "Ask first",
  auto_edit: "Can edit files",
};
const POPOVER =
  "z-30 rounded-[10px] border bg-popover p-1.5 text-xs text-popover-foreground shadow-lg";
const ITEM =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";
const TRIGGER =
  "h-7 shrink-0 gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground";

/**
 * M10 step 16 (CH-19), calmer in step 26: what a new Code or Work session needs before it
 * starts, in one quiet row above the composer: its project first, where it runs, and Run
 * settings (kind, mode, cost cap, new branch) behind one button that says what's set. A choice
 * that can't be made here stays visible in its menu, with why (PL-02).
 */
export function NewSessionBar({
  projects,
  projectId,
  onProject,
  where,
  onWhere,
  whereReasons,
  onOpenHulkSettings,
  capMicroUsd,
  defaultCapMicroUsd,
  onCap,
  run,
}: {
  projects: { id: string; name: string }[];
  projectId: string | null;
  onProject: (projectId: string | null) => void;
  where: "local" | "hulk";
  onWhere: (where: "local" | "hulk") => void;
  /** Why each place can't be picked; null when it can. */
  whereReasons: { local: string | null; hulk: string | null };
  /** Opens Settings → HULK, offered when HULK isn't paired yet. */
  onOpenHulkSettings?: () => void;
  /** This session's own cap; null uses the project's, then FUSE's. */
  capMicroUsd: number | null;
  defaultCapMicroUsd: number;
  onCap: (capMicroUsd: number | null) => void;
  /** Kind, mode and branch, once there's a folder to run in. */
  run?: {
    kind: "code" | "work";
    onKind: (kind: "code" | "work") => void;
    mode: Mode;
    onMode: (mode: Mode) => void;
    branch: boolean;
    onBranch: (on: boolean) => void;
  };
}) {
  const active = usePanelActive();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);
  usePanelLeave(() => {
    setPlaceOpen(false);
    setSettingsOpen(false);
  });
  const capField = useRef<HTMLInputElement>(null);
  /** Saves what's typed in the cap: on blur, Enter, or when Run settings closes. */
  const commitCap = () => {
    const raw = capField.current?.value;
    if (raw === undefined) return;
    const n = Number(raw);
    const micro =
      raw.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 1_000_000);
    if (micro !== capMicroUsd) onCap(micro);
  };
  const local = {
    id: "local" as const,
    label: "This computer",
    icon: <Laptop className="size-3.5" />,
  };
  const hulk = { id: "hulk" as const, label: "HULK", icon: <Server className="size-3.5" /> };
  const places = [local, hulk];
  const here = where === "hulk" ? hulk : local;
  const cap = capMicroUsd ?? defaultCapMicroUsd;
  const summary = [
    ...(run ? [run.kind === "work" ? "Work" : "Coding", MODE_NAMES[run.mode]] : []),
    `cap ${money(cap)}`,
  ].join(" · ");
  return (
    <div
      data-new-session
      aria-label="New session"
      role="group"
      className="flex min-w-0 items-center gap-1 pb-1.5 text-xs"
    >
      <label className="relative flex min-w-0 shrink-0 items-center">
        <span className="sr-only">Project or repository</span>
        <FolderOpen
          className="pointer-events-none absolute left-2 size-3.5 text-foreground"
          aria-hidden
        />
        <select
          aria-label="Project or repository"
          className="h-7 max-w-[220px] cursor-pointer @max-[480px]:max-w-[150px] appearance-none truncate rounded-md bg-transparent pr-6 pl-7 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          value={projectId ?? ""}
          onChange={(e) => {
            onProject(e.target.value || null);
          }}
        >
          <option value="">Choose project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-1.5 size-3 text-muted-foreground"
          aria-hidden
        />
      </label>
      <Popover.Root open={placeOpen && active} onOpenChange={setPlaceOpen}>
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Where it runs: ${here.label}`}
            className={TRIGGER}
          >
            {here.icon}
            <span className="@max-[480px]:sr-only">{here.label}</span>
            <ChevronDown className="size-3" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            side="top"
            sideOffset={6}
            collisionPadding={12}
            aria-label="Where it runs"
            className={`${POPOVER} w-72`}
          >
            <div role="group" aria-label="Where it runs">
              {places.map((p) => {
                const why = whereReasons[p.id];
                return (
                  <div key={p.id}>
                    <button
                      type="button"
                      aria-pressed={where === p.id}
                      disabled={why !== null}
                      title={why ?? undefined}
                      className={ITEM}
                      onClick={() => {
                        onWhere(p.id);
                        setPlaceOpen(false);
                      }}
                    >
                      {p.icon}
                      <span className="flex-1">{p.label}</span>
                      {where === p.id && <Check className="size-3.5" aria-hidden />}
                    </button>
                    {why !== null && (
                      <p className="px-2 pb-1.5 pl-[30px] text-[11px] leading-snug text-muted-foreground">
                        <span>{why}</span>
                        {p.id === "hulk" && onOpenHulkSettings && /^Pair/.test(why) && (
                          <>
                            {" "}
                            <button
                              type="button"
                              className="underline underline-offset-2 hover:text-foreground"
                              onClick={() => {
                                setPlaceOpen(false);
                                onOpenHulkSettings();
                              }}
                            >
                              Open Settings
                            </button>
                          </>
                        )}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <span className="flex-1" />
      <Popover.Root
        open={settingsOpen && active}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) commitCap();
        }}
      >
        <Popover.Trigger asChild>
          <Button variant="ghost" size="sm" aria-label="Run settings" className={TRIGGER}>
            <span className="truncate tabular-nums @max-[620px]:hidden" aria-hidden>
              {summary}
            </span>
            <SlidersHorizontal className="size-3.5" />
            <span>Run settings</span>
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            side="top"
            sideOffset={6}
            collisionPadding={12}
            aria-label="Run settings"
            className={`${POPOVER} flex w-64 flex-col gap-1`}
          >
            {run && (
              <>
                <p className="px-2 pt-1 text-[11px] text-muted-foreground">Kind</p>
                <div role="group" aria-label="Kind" className="flex gap-1 px-1">
                  {(["code", "work"] as const).map((k) => (
                    <Button
                      key={k}
                      variant="ghost"
                      size="sm"
                      aria-pressed={run.kind === k}
                      aria-label={k === "code" ? "Coding run" : "Work run"}
                      className={`h-7 flex-1 text-xs ${run.kind === k ? "bg-foreground text-background hover:bg-foreground hover:text-background" : "text-muted-foreground"}`}
                      onClick={() => {
                        run.onKind(k);
                      }}
                    >
                      {k === "code" ? "Coding" : "Work"}
                    </Button>
                  ))}
                </div>
                <label className="flex items-center gap-2 px-2 py-1">
                  <span className="flex-1 text-muted-foreground">May</span>
                  <span className="relative flex items-center">
                    <select
                      aria-label="What the coding run may do"
                      className="h-7 appearance-none rounded-md border border-input bg-background pr-6 pl-2 text-xs text-foreground"
                      value={run.mode}
                      onChange={(e) => {
                        const v = e.target.value;
                        run.onMode(v === "auto_edit" ? "auto_edit" : v === "plan" ? "plan" : "ask");
                      }}
                    >
                      {(Object.keys(MODE_NAMES) as Mode[]).map((m) => (
                        <option key={m} value={m}>
                          {MODE_NAMES[m]}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      className="pointer-events-none absolute right-1.5 size-3 text-muted-foreground"
                      aria-hidden
                    />
                  </span>
                </label>
              </>
            )}
            <label className="flex items-center gap-2 px-2 py-1">
              <span className="flex-1 text-muted-foreground">Cost cap $</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                aria-label="Cost cap"
                className="h-7 w-20 rounded-md border border-input bg-background px-2 text-right text-xs tabular-nums"
                placeholder={(defaultCapMicroUsd / 1_000_000).toFixed(2)}
                defaultValue={capMicroUsd === null ? "" : (capMicroUsd / 1_000_000).toFixed(2)}
                key={`cap-${String(capMicroUsd)}`}
                ref={capField}
                onBlur={commitCap}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCap();
                }}
              />
            </label>
            {run && run.kind === "code" && run.mode !== "plan" && (
              <label className="flex items-center gap-2 px-2 py-1">
                <span className="flex-1 text-muted-foreground">New branch</span>
                <input
                  type="checkbox"
                  aria-label="New branch"
                  checked={run.branch}
                  onChange={(e) => {
                    run.onBranch(e.target.checked);
                  }}
                />
              </label>
            )}
            {!run && (
              <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground">
                Kind and permissions appear once the session has a folder.
              </p>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
