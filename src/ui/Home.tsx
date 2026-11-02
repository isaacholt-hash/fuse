import { Laptop, Server, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { money } from "./format";
import { Mark, Money } from "./primitives";
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
  /**
   * M10 step 25 (CO-02): the month so far, where it lands at this pace, and the month budget
   * when there is one.
   */
  month?: { spentMicro: number; projectedMicro: number; budgetMicro: number | null } | null;
}

/** Each list shows this many, so the composer stays on screen at every width. */
const MAX_ROWS = 5;

/** The ledger grid: the item beside its 132 px figure column; one column when narrow. */
const GRID =
  "grid grid-cols-[minmax(0,1fr)_132px] gap-x-6 @max-[760px]:grid-cols-[minmax(0,1fr)] @max-[760px]:gap-x-0";

/**
 * M10 step 14: a new chat or session opens on what's happening: runs waiting for you, runs going,
 * the next scheduled tasks and today's spend, each a click away. With nothing happening it's the
 * area's greeting. The Code area leads with sessions, the Chat area with today's spend.
 *
 * M10 step 25: each list is two columns, like the ledger: the item on the left, its time and
 * money on the right; Today has the day-cap line and the pace sentence.
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
  empty: { heading: string };
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
      <h1 className="text-2xl font-medium tracking-tight">{empty.heading}</h1>
      {!busy && (
        <>
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
  const runs = (title: string, state: "waiting" | "going", rows: HomeRun[]) =>
    rows.length > 0 && (
      <Section title={title} key={title}>
        {rows.slice(0, MAX_ROWS).map((r) => (
          <Row
            key={r.id}
            label={r.title}
            state={state}
            right={
              <>
                {r.activeSince !== null && (
                  <span className="block">
                    <RunningFor since={r.activeSince} prefix="" />
                  </span>
                )}
                {r.spentMicro !== null && (
                  <span className="block">
                    <Money micro={r.spentMicro} className="text-[13px]" /> so far
                  </span>
                )}
              </>
            }
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
                <Server className="size-3 shrink-0" aria-label="On HULK" />
              ) : (
                <Laptop className="size-3 shrink-0" aria-label="On this computer" />
              )}
              {r.detail && <span className="truncate">{r.detail}</span>}
            </span>
          </Row>
        ))}
      </Section>
    );
  const scheduled = view.scheduled.length > 0 && (
    <Section title="Next scheduled" key="scheduled">
      {view.scheduled.slice(0, MAX_ROWS).map((s) => (
        <Row
          key={s.id}
          label={s.name}
          state={null}
          right={<span className="block">{s.when}</span>}
          {...(s.threadId
            ? {
                onOpen: () => {
                  if (s.threadId) onOpen(s.threadId);
                },
              }
            : {})}
        >
          {s.where}
        </Row>
      ))}
    </Section>
  );
  const today = view.today && (
    <Section title="Today" key="today">
      <div className="col-span-full max-w-[68ch] text-[13px]">
        <p>
          <Money micro={view.today.spentMicro} className="text-[13px]" />
          <span className="text-muted-foreground">
            {view.today.budgetMicro !== null
              ? ` of a ${money(view.today.budgetMicro)} day cap`
              : " spent today"}
          </span>
        </p>
        {view.today.budgetMicro !== null && (
          <div
            role="img"
            aria-label={`${money(view.today.spentMicro)} of ${money(view.today.budgetMicro)}`}
            className="my-2 h-[2px] w-full overflow-hidden rounded-[1px] bg-border"
          >
            <div
              className="h-full bg-foreground"
              style={{
                width: `${String(Math.min(100, (view.today.spentMicro / view.today.budgetMicro) * 100))}%`,
              }}
            />
          </div>
        )}
        {view.month && view.month.spentMicro > 0 && (
          <p className="text-muted-foreground">
            At this pace: about {money(view.month.projectedMicro)} by month end
            {view.month.budgetMicro !== null ? `, budget ${money(view.month.budgetMicro)}.` : "."}
          </p>
        )}
      </div>
    </Section>
  );
  const parts = [
    runs("Waiting for you", "waiting", view.waiting),
    runs("Going", "going", view.going),
    scheduled,
  ];
  return (
    <div className="@container mx-auto flex min-h-full w-[min(100%,calc(68ch+132px+88px))] flex-col justify-center px-8 py-8 text-[15px] max-[800px]:px-5">
      {greeting}
      {busy && (
        <div className="mt-8" aria-label="What's happening">
          {area === "chat" ? [today, ...parts] : [...parts, today]}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className={`${GRID} border-t py-3`}>
      <h2 className="col-span-full mb-1.5 text-[13px] font-medium text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Filled ink = waiting for you; hollow and pulsing = going; none for a scheduled task. */
const DOT = {
  waiting: "border-foreground bg-foreground",
  going: "animate-pulse border-muted-foreground",
};

function Row({
  label,
  state,
  right,
  onOpen,
  children,
}: {
  label: string;
  state: "waiting" | "going" | null;
  /** The figure column: time and money. */
  right: ReactNode;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-2.5">
        {state && (
          <span
            aria-hidden
            className={`mt-1 inline-block size-2 shrink-0 self-center rounded-full border-[1.5px] ${DOT[state]}`}
          />
        )}
        <span className="min-w-0">
          <span className="block truncate font-medium">{label}</span>
          <span className="block truncate text-[13px] text-muted-foreground">{children}</span>
        </span>
      </span>
      <span className="text-right text-[12px] leading-[1.5] text-muted-foreground tabular-nums @max-[760px]:pl-[18px] @max-[760px]:text-left">
        {right}
      </span>
    </>
  );
  const cls = `${GRID} w-full py-1.5 text-left @max-[760px]:gap-y-0`;
  return onOpen ? (
    <button
      type="button"
      className={`${cls} col-span-full rounded-md hover:bg-muted/50`}
      aria-label={`Open ${label}`}
      onClick={onOpen}
    >
      {body}
    </button>
  ) : (
    <div className={`${cls} col-span-full`}>{body}</div>
  );
}
