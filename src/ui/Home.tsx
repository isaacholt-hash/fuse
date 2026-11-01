import { CalendarClock, CircleDot, Hand, Laptop, Server, Sparkles, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { money } from "./format";
import { Mark } from "./primitives";
import { RunningFor } from "./RunningFor";
import type { Area } from "./types";

/** A run on the home screen: waiting for an answer, or going. */
export interface HomeRun {
  id: string;
  /** Its chat, when it has one this app can open. */
  threadId: string | null;
  title: string;
  /** The question waiting (first line), or what it's doing. */
  detail: string | null;
  /** While going: when its active time counts from. */
  activeSince: number | null;
  spentMicro: number | null;
  place: "local" | "hulk";
}

export interface HomeSchedule {
  id: string;
  name: string;
  /** e.g. "Today 18:00". */
  when: string;
  where: string;
  /** Its last chat, when this app can open it. */
  threadId: string | null;
}

export interface HomeView {
  waiting: HomeRun[];
  going: HomeRun[];
  scheduled: HomeSchedule[];
  /** Spent today, and the day budget when there is one. */
  today: { spentMicro: number; budgetMicro: number | null } | null;
}

/** Each list shows this many, so the composer stays on screen at every width. */
const MAX_ROWS = 5;

/**
 * M10 step 14: a new chat or session opens on what's happening: runs waiting for you, runs going,
 * the next scheduled tasks and today's spend, each a click away. With nothing happening it's the
 * area's greeting. The Code area leads with sessions, the Chat area with today's spend.
 */
export function Home({
  area,
  view,
  empty,
  modelName,
  onOpen,
}: {
  area: Area;
  view: HomeView;
  empty: { kicker: string; heading: string; blurb: string };
  modelName: string;
  onOpen: (threadId: string) => void;
}) {
  const busy =
    view.waiting.length > 0 ||
    view.going.length > 0 ||
    view.scheduled.length > 0 ||
    (view.today !== null && view.today.spentMicro > 0);
  // One layout whether or not anything is happening, so the greeting never remounts when the
  // lists arrive.
  const greeting = (
    <div className="flex flex-col items-center text-center">
      <div className="mb-5">
        <Mark />
      </div>
      <p className="mb-2 text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
        {empty.kicker}
      </p>
      <h1 className="text-2xl font-medium tracking-tight">{empty.heading}</h1>
      {!busy && (
        <>
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">{empty.blurb}</p>
          <div className="mt-7 flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="size-3" />
            {modelName}
            <span className="mx-1 opacity-40">/</span>
            <span>Ctrl+K to change</span>
          </div>
        </>
      )}
    </div>
  );
  const runs = (title: string, icon: ReactNode, rows: HomeRun[]) =>
    rows.length > 0 && (
      <Section title={title} icon={icon} key={title}>
        {rows.slice(0, MAX_ROWS).map((r) => (
          <Row
            key={r.id}
            label={r.title}
            {...(r.threadId
              ? {
                  onOpen: () => {
                    if (r.threadId) onOpen(r.threadId);
                  },
                }
              : {})}
          >
            <span className="flex items-center gap-1.5">
              {r.place === "hulk" ? (
                <Server className="size-3" aria-label="On HULK" />
              ) : (
                <Laptop className="size-3" aria-label="On this computer" />
              )}
              {r.detail && <span className="truncate">{r.detail}</span>}
              {r.activeSince !== null && (
                <span className="shrink-0">
                  <RunningFor since={r.activeSince} prefix="" />
                </span>
              )}
              {r.spentMicro !== null && (
                <span className="shrink-0 font-mono">{money(r.spentMicro)}</span>
              )}
            </span>
          </Row>
        ))}
      </Section>
    );
  const scheduled = view.scheduled.length > 0 && (
    <Section title="Next scheduled" icon={<CalendarClock className="size-3.5" />} key="scheduled">
      {view.scheduled.slice(0, MAX_ROWS).map((s) => (
        <Row
          key={s.id}
          label={s.name}
          {...(s.threadId
            ? {
                onOpen: () => {
                  if (s.threadId) onOpen(s.threadId);
                },
              }
            : {})}
        >
          {s.when} · {s.where}
        </Row>
      ))}
    </Section>
  );
  const today = view.today && (
    <Section title="Today" icon={<Wallet className="size-3.5" />} key="today">
      <p className="px-3 py-2 text-sm">
        <span className="font-mono">{money(view.today.spentMicro)}</span>
        {view.today.budgetMicro !== null && (
          <span className="text-muted-foreground">
            {" "}
            of {money(view.today.budgetMicro)} today (
            {Math.round((view.today.spentMicro / view.today.budgetMicro) * 100)}%)
          </span>
        )}
        {view.today.budgetMicro === null && (
          <span className="text-muted-foreground"> spent today</span>
        )}
      </p>
    </Section>
  );
  const parts = [
    runs("Waiting for you", <Hand className="size-3.5" />, view.waiting),
    runs("Going", <CircleDot className="size-3.5" />, view.going),
    scheduled,
  ];
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-4 py-8">
      {greeting}
      {busy && (
        <div className="mt-6 space-y-4" aria-label="What's happening">
          {area === "chat" ? [today, ...parts] : [...parts, today]}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h2 className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
        {icon}
        {title}
      </h2>
      <div className="max-h-[220px] divide-y overflow-y-auto rounded-lg border">{children}</div>
    </section>
  );
}

function Row({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="block truncate text-sm font-medium">{label}</span>
      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{children}</span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="block w-full px-3 py-2 text-left hover:bg-muted/50"
      aria-label={`Open ${label}`}
      onClick={onOpen}
    >
      {body}
    </button>
  ) : (
    <div className="px-3 py-2">{body}</div>
  );
}
