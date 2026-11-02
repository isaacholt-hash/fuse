import { BellOff } from "lucide-react";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import {
  BANNER_LABELS,
  SYSTEM_LABELS,
  describeQuiet,
  hhmm,
  toMinute,
  type BannerKind,
  type NotificationSettings,
  type SystemKind,
} from "@/data/notifications";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SYSTEM_KINDS: SystemKind[] = ["waiting", "finished", "budget"];
const BANNER_KINDS: BannerKind[] = [
  "update",
  "routing",
  "models",
  "prices",
  "continueInCode",
  "budget",
];

/**
 * Settings → Notifications (M10 step 21, PL-07): a switch per sound, system notification and
 * banner, the sound off until turned on, and quiet hours that silence the lot. A run that
 * needs you during quiet hours still shows on the home screen.
 */
export function NotificationsSection({
  settings,
  onChange,
}: {
  settings: NotificationSettings;
  onChange: (next: NotificationSettings) => void;
}) {
  const ids = { sound: useId(), quiet: useId(), from: useId(), to: useId() };
  const box = "size-3.5 accent-foreground";
  const row = "flex items-center gap-2 text-xs";
  return (
    <section className="mt-8 border-t pt-6" aria-label="Notifications">
      <div className="mb-1 flex items-center gap-2">
        <BellOff className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Notifications</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        What FUSE may tell you about, and when it stays quiet. Nothing makes a sound unless you turn
        the sound on. During quiet hours a run that needs you waits silently and shows on the home
        screen.
      </p>

      <label htmlFor={ids.sound} className={row}>
        <input
          id={ids.sound}
          type="checkbox"
          className={box}
          checked={settings.sound}
          onChange={(e) => {
            onChange({ ...settings, sound: e.target.checked });
          }}
        />
        Play a sound with notifications
      </label>

      <fieldset className="mt-4">
        <legend className="mb-1 text-xs font-medium">System notifications</legend>
        <div className="grid gap-1.5">
          {SYSTEM_KINDS.map((k) => (
            <label key={k} className={row}>
              <input
                type="checkbox"
                className={box}
                checked={settings.system[k]}
                onChange={(e) => {
                  onChange({ ...settings, system: { ...settings.system, [k]: e.target.checked } });
                }}
              />
              {SYSTEM_LABELS[k]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="mb-1 text-xs font-medium">Banners in the app</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {BANNER_KINDS.map((k) => (
            <label key={k} className={row}>
              <input
                type="checkbox"
                className={box}
                checked={settings.banners[k]}
                onChange={(e) => {
                  onChange({
                    ...settings,
                    banners: { ...settings.banners, [k]: e.target.checked },
                  });
                }}
              />
              {BANNER_LABELS[k]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4" aria-label="Quiet hours">
        <legend className="mb-1 text-xs font-medium">Quiet hours</legend>
        <label htmlFor={ids.quiet} className={row}>
          <input
            id={ids.quiet}
            type="checkbox"
            className={box}
            checked={settings.quiet.on}
            onChange={(e) => {
              onChange({ ...settings, quiet: { ...settings.quiet, on: e.target.checked } });
            }}
          />
          Keep quiet on these days and hours
        </label>
        <div role="group" aria-label="Quiet days" className="mt-2 flex flex-wrap gap-1">
          {DAYS.map((name, i) => (
            <button
              key={name}
              type="button"
              aria-pressed={settings.quiet.days[i] === true}
              disabled={!settings.quiet.on}
              className={`rounded-md border px-2 py-1 text-xs disabled:opacity-50 ${settings.quiet.days[i] ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => {
                const days = [...settings.quiet.days];
                days[i] = !days[i];
                onChange({ ...settings, quiet: { ...settings.quiet, days } });
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <label htmlFor={ids.from}>From</label>
          <Input
            id={ids.from}
            type="time"
            className="h-7 w-28 text-xs"
            disabled={!settings.quiet.on}
            value={hhmm(settings.quiet.from)}
            onChange={(e) => {
              const from = toMinute(e.target.value);
              if (from !== null) onChange({ ...settings, quiet: { ...settings.quiet, from } });
            }}
          />
          <label htmlFor={ids.to}>to</label>
          <Input
            id={ids.to}
            type="time"
            className="h-7 w-28 text-xs"
            disabled={!settings.quiet.on}
            value={hhmm(settings.quiet.to)}
            onChange={(e) => {
              const to = toMinute(e.target.value);
              if (to !== null) onChange({ ...settings, quiet: { ...settings.quiet, to } });
            }}
          />
          <span className="text-muted-foreground">
            The same time twice means the whole day. An evening-to-morning range runs overnight.
          </span>
        </div>
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {describeQuiet(settings.quiet)}
        </p>
      </fieldset>
    </section>
  );
}
