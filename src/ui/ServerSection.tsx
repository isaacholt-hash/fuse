import { LogOut, MonitorSmartphone, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AuthApi, Device, PairCode } from "@/platform/auth";
import { Modal } from "./primitives";

const day = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const time = (secs: number) =>
  new Date(secs * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Settings → FUSE on HULK (M10 steps 4 and 5), in the web app only: the server's version
 * (PL-06), the devices paired with it (pair one with a one-time code, revoke one), and Sign out.
 */
export function ServerSection({
  version,
  auth,
  onSignedOut,
  now = () => Date.now(),
}: {
  version: string;
  auth: AuthApi;
  /** After Sign out: back to the sign-in screen. */
  onSignedOut: () => void;
  /** Milliseconds; tests pass a fixed clock. */
  now?: () => number;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [code, setCode] = useState<PairCode | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const said = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  };
  const load = () => auth.devices().then(setDevices, said);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when Settings opens
  }, [auth]);
  const minutesLeft = code ? Math.max(0, Math.ceil((code.expiresAt * 1000 - now()) / 60_000)) : 0;
  return (
    <section className="mt-8 border-t pt-6" aria-label="FUSE on HULK">
      <div className="mb-1 flex items-center gap-2">
        <Server className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">FUSE on HULK</h2>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          FUSE on HULK {version}
        </span>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        This is the web app, served by HULK. It has its own chats and keys, kept on HULK; the
        desktop app&apos;s stay on their computers.
      </p>
      <div role="group" aria-label="Devices">
        <div className="mb-1 flex items-center gap-2">
          <MonitorSmartphone className="size-3.5 text-muted-foreground" />
          <h3 className="text-xs font-medium">Devices</h3>
        </div>
        <p className="mb-2 text-[11px] leading-5 text-muted-foreground">
          A desktop app pairs with a one-time code, and then reaches HULK with its own token. Revoke
          a device you no longer use.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              auth.pairCode().then(setCode, said);
            }}
          >
            Pair a device
          </Button>
          {code && (
            <p role="status" className="text-[11px] text-muted-foreground">
              Code{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground select-all">
                {code.code}
              </code>{" "}
              · works once, until {time(code.expiresAt)}
              {minutesLeft > 0 ? ` (${String(minutesLeft)} min)` : " (expired)"}
            </p>
          )}
        </div>
        {devices === null ? (
          <p className="mt-2 text-[11px] text-muted-foreground">Loading devices…</p>
        ) : devices.length === 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">No devices paired yet.</p>
        ) : (
          <ul className="mt-3 divide-y rounded-md border text-xs" aria-label="Paired devices">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{d.name}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Paired {day(d.createdAt)} ·{" "}
                    {d.lastUsedAt === null ? "never used" : `last used ${day(d.lastUsedAt)}`}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  aria-label={`Revoke ${d.name}`}
                  onClick={() => {
                    setRevoking(d);
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[11px] text-destructive">
          {error}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="mt-4"
        onClick={() => {
          auth.signOut().then(onSignedOut, said);
        }}
      >
        <LogOut className="size-3.5" />
        Sign out
      </Button>
      <Modal
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke ${revoking?.name ?? "this device"}?`}
        description="It can't reach FUSE on HULK any more. To use it again, pair it with a new code."
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setRevoking(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const d = revoking;
              setRevoking(null);
              if (d) auth.revoke(d.id).then(load, said);
            }}
          >
            Revoke
          </Button>
        </div>
      </Modal>
    </section>
  );
}
