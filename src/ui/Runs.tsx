import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePause,
  Hand,
  Square,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** How a run shows in the Runs list: "waiting" means it has a question no one has answered. */
export type RunListStatus = "going" | "waiting" | "done" | "stopped" | "paused" | "failed";

export interface RunListRow {
  id: string;
  task: string;
  /** Its chat's title; null when it has none. */
  chat: string | null;
  threadId: string | null;
  status: RunListStatus;
  /** Why it failed, stopped or paused. */
  note: string | null;
  /** e.g. "2 min ago". */
  when: string;
}

const LOOK: Record<RunListStatus, { label: string; icon: ReactNode; tone: string }> = {
  going: {
    label: "Going",
    icon: <CircleDot className="size-3.5 animate-pulse" />,
    tone: "text-foreground",
  },
  waiting: {
    label: "Waiting for you",
    icon: <Hand className="size-3.5" />,
    tone: "text-amber-700 dark:text-amber-400",
  },
  done: {
    label: "Done",
    icon: <CircleCheck className="size-3.5" />,
    tone: "text-emerald-700 dark:text-emerald-400",
  },
  stopped: {
    label: "Stopped",
    icon: <Square className="size-3.5" />,
    tone: "text-muted-foreground",
  },
  paused: {
    label: "Paused",
    icon: <CirclePause className="size-3.5" />,
    tone: "text-muted-foreground",
  },
  failed: { label: "Failed", icon: <CircleAlert className="size-3.5" />, tone: "text-destructive" },
};

/**
 * The web app's Runs list (M10 step 6): recent runs on HULK across every chat, going on with or
 * without a page open. A row opens its chat, where a waiting question can be answered.
 */
export function RunsScreen({
  rows,
  onOpen,
  onBack,
}: {
  rows: RunListRow[] | null;
  onOpen: (threadId: string) => void;
  onBack: () => void;
}) {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <header className="flex h-[66px] items-center border-b px-6">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          Back to conversation
        </Button>
      </header>
      <div className="mx-auto max-w-[760px] px-4 py-9 sm:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="mt-2 text-xs text-muted-foreground">
          Code and Work runs on HULK. They keep going with this page closed; a run that needs your
          OK waits here until you answer it in its chat.
        </p>
        {rows === null ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading runs…</p>
        ) : rows.length === 0 ? (
          <p className="mt-8 text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="mt-6 divide-y rounded-lg border" aria-label="Recent runs">
            {rows.map((r) => {
              const look = LOOK[r.status];
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50 disabled:cursor-default"
                    disabled={!r.threadId}
                    aria-label={`${r.task}: ${look.label}`}
                    onClick={() => {
                      if (r.threadId) onOpen(r.threadId);
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.task}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {r.chat ?? "No chat"} · {r.when}
                      </span>
                      {r.note && (r.status === "failed" || r.status === "paused") && (
                        <span
                          className={`mt-1 block text-[11px] ${r.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                        >
                          {r.note}
                        </span>
                      )}
                    </span>
                    <span
                      className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${look.tone}`}
                    >
                      {look.icon}
                      {look.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
