import { Fingerprint, Lock, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Mark } from "./primitives";

/** The lock screen (SE-03). Nothing of the app is rendered behind it. */
export function LockScreen({
  onUnlock,
  waitUntil,
  onHello,
}: {
  /** Checks a passcode; true unlocks. */
  onUnlock: (passcode: string) => Promise<boolean>;
  /** After too many wrong tries: no tries before this time (Unix ms). */
  waitUntil: number;
  /** Windows Hello, when it's set up and turned on; true unlocks. */
  onHello?: () => Promise<boolean>;
}) {
  const [passcode, setPasscode] = useState("");
  const [helloFailed, setHelloFailed] = useState(false);
  const askHello = useCallback(() => {
    if (!onHello) return;
    setHelloFailed(false);
    onHello().then(
      (ok) => {
        if (!ok) setHelloFailed(true);
      },
      () => {
        setHelloFailed(true);
      },
    );
  }, [onHello]);
  // Windows Hello is asked once as the lock screen appears; the button asks again.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    askHello();
  }, [askHello]);
  const [checking, setChecking] = useState(false);
  const [wrong, setWrong] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (waitUntil <= now) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [waitUntil, now]);
  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  return (
    <main
      className="flex h-dvh items-center justify-center bg-background text-foreground"
      aria-label="FUSE is locked"
    >
      <form
        className="w-80 text-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (!passcode || wait > 0 || checking) return;
          setChecking(true);
          void onUnlock(passcode).then((ok) => {
            setChecking(false);
            if (!ok) {
              setWrong(true);
              setPasscode("");
              setNow(Date.now());
            }
          });
        }}
      >
        <div className="mb-5 flex justify-center">
          <Mark />
        </div>
        <h1 className="flex items-center justify-center gap-2 text-lg font-semibold">
          <Lock className="size-4" /> FUSE is locked
        </h1>
        <Input
          type="password"
          aria-label="Passcode"
          autoFocus
          className="mt-5"
          value={passcode}
          disabled={wait > 0}
          onChange={(e) => {
            setPasscode(e.target.value);
            setWrong(false);
          }}
        />
        <p role="status" className="mt-2 h-4 text-[11px] text-muted-foreground">
          {wait > 0
            ? `Too many wrong tries. Try again in ${String(wait)} s.`
            : wrong
              ? "That passcode isn't right."
              : ""}
        </p>
        <Button type="submit" className="mt-3 w-full" disabled={!passcode || wait > 0 || checking}>
          {checking ? <LoaderCircle className="size-4 animate-spin" /> : "Unlock"}
        </Button>
        {onHello && (
          <>
            <Button type="button" variant="outline" className="mt-2 w-full" onClick={askHello}>
              <Fingerprint className="size-4" />
              Use Windows Hello
            </Button>
            {helloFailed && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Windows Hello didn&apos;t confirm it&apos;s you. Try again or use your passcode.
              </p>
            )}
          </>
        )}
      </form>
    </main>
  );
}

const IDLE_CHOICES = [
  { minutes: 5, label: "5 minutes" },
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 0, label: "Only when FUSE starts" },
];

/** Settings → App lock (SE-03). */
export function AppLockSection({
  enabled,
  idleMinutes,
  minLength,
  onSet,
  onRemove,
  onIdle,
  hello,
  onHello,
}: {
  /** Windows Hello is turned on; both unset when it isn't set up on this PC. */
  hello?: boolean;
  onHello?: (on: boolean) => void;
  enabled: boolean;
  idleMinutes: number;
  minLength: number;
  /** Sets or changes the passcode; returns an error to show, or null. */
  onSet: (passcode: string, current: string | null) => Promise<string | null>;
  onRemove: (current: string) => Promise<string | null>;
  onIdle: (minutes: number) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const mismatch = next !== again;
  const ok = next.length >= minLength && !mismatch && (!enabled || current.length > 0);
  const done = (msg: string | null, success: string) => {
    setStatus(msg ?? success);
    if (!msg) {
      setCurrent("");
      setNext("");
      setAgain("");
    }
  };
  return (
    <section className="mt-8 border-t pt-6" aria-label="App lock">
      <div className="mb-1 flex items-center gap-2">
        <Lock className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">App lock</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Ask for a passcode when FUSE starts and after it&apos;s been left alone. Only a salted hash
        of the passcode is stored. There&apos;s no way to recover a forgotten one except Delete
        everything.
      </p>
      <div className="grid max-w-sm gap-2">
        {enabled && (
          <Input
            type="password"
            aria-label="Current passcode"
            placeholder="Current passcode"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
            }}
          />
        )}
        <Input
          type="password"
          aria-label="New passcode"
          placeholder={`New passcode (at least ${String(minLength)} characters)`}
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
          }}
        />
        <Input
          type="password"
          aria-label="New passcode again"
          placeholder="New passcode again"
          value={again}
          onChange={(e) => {
            setAgain(e.target.value);
          }}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!ok}
            onClick={() => {
              void onSet(next, enabled ? current : null).then((m) => {
                done(m, enabled ? "Passcode changed." : "App lock is on.");
              });
            }}
          >
            {enabled ? "Change passcode" : "Turn on app lock"}
          </Button>
          {enabled && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!current}
              onClick={() => {
                void onRemove(current).then((m) => {
                  done(m, "App lock is off.");
                });
              }}
            >
              Turn off
            </Button>
          )}
        </div>
      </div>
      {enabled && (
        <label className="mt-3 flex items-center gap-2 text-xs">
          Lock after
          <select
            aria-label="Lock after"
            className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
            value={idleMinutes}
            onChange={(e) => {
              onIdle(Number(e.target.value));
            }}
          >
            {IDLE_CHOICES.map((c) => (
              <option key={c.minutes} value={c.minutes}>
                {c.label}
              </option>
            ))}
          </select>
          of no use
        </label>
      )}
      {enabled && onHello && (
        <label className="mt-2 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={hello ?? false}
            onChange={(e) => {
              onHello(e.target.checked);
            }}
          />
          Unlock with Windows Hello (face, fingerprint or PIN); the passcode still works
        </label>
      )}
      <p role="status" className="mt-2 text-[11px] text-muted-foreground">
        {status ?? (enabled ? "App lock is on." : "App lock is off.")}
      </p>
    </section>
  );
}
