import { ExternalLink, Server } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { HulkStatus } from "@/handover/api";
import { LOOK_LABEL, type HandoverLook } from "@/handover/watch";
import { openExternal } from "./openExternal";

/**
 * Settings → HULK (M10 step 7), desktop only: pair this computer with FUSE on HULK using a
 * one-time code from HULK's Settings → Devices, so Code runs can be handed over to it. The
 * device token stays in this computer's keychain.
 */
export function HulkSection({
  status,
  onPair,
  onUnpair,
}: {
  /** Null while it loads. */
  status: HulkStatus | null;
  /** Resolves to the server's words when it says no, or null once paired. */
  onPair: (address: string, code: string, name: string) => Promise<string | null>;
  onUnpair: () => Promise<string | null>;
}) {
  const [address, setAddress] = useState(status?.address ?? "");
  const [code, setCode] = useState("");
  const [name, setName] = useState("This desktop");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const ids = { address: useId(), code: useId(), name: useId() };
  const run = (task: () => Promise<string | null>) => {
    setBusy(true);
    setSaid(null);
    task().then(
      (m) => {
        setBusy(false);
        setSaid(m);
      },
      (e: unknown) => {
        setBusy(false);
        setSaid(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const label = "mb-1 block text-xs font-medium";
  return (
    <section className="mt-8 border-t pt-6" aria-label="HULK">
      <div className="mb-1 flex items-center gap-2">
        <Server className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">HULK</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        FUSE on HULK runs Code runs with this computer closed. Pair once, then &quot;Run on
        HULK&quot; in a project&apos;s Code composer hands a run over: HULK works on its own branch
        and asks before pushing it.
      </p>
      {status === null ? (
        <p className="text-[11px] text-muted-foreground">Checking…</p>
      ) : status.paired ? (
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-x-2 text-xs">
            <span className="font-mono">{status.address}</span>
            <span className="text-emerald-700 dark:text-emerald-400">Paired</span>
            <button
              type="button"
              className="flex items-center gap-1 text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                openExternal(status.address ?? undefined);
              }}
            >
              Open HULK
              <ExternalLink className="size-3" />
            </button>
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              run(onUnpair);
            }}
          >
            Unpair
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Unpairing forgets this computer&apos;s token. Revoke the device in HULK&apos;s Settings
            → Devices too.
          </p>
        </div>
      ) : (
        <form
          className="grid max-w-md gap-2"
          aria-label="Pair with HULK"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => onPair(address.trim(), code.trim(), name.trim() || "This desktop"));
          }}
        >
          <div>
            <label htmlFor={ids.address} className={label}>
              HULK&apos;s address
            </label>
            <Input
              id={ids.address}
              className="font-mono text-xs"
              spellCheck={false}
              placeholder="https://hulk.tailb7c872.ts.net:4100"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
              }}
            />
          </div>
          <div>
            <label htmlFor={ids.code} className={label}>
              Pairing code
            </label>
            <Input
              id={ids.code}
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
              placeholder="From HULK's Settings → Devices, e.g. ABCD-EFGH"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
          </div>
          <div>
            <label htmlFor={ids.name} className={label}>
              This computer&apos;s name on HULK
            </label>
            <Input
              id={ids.name}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          <div>
            <Button type="submit" size="sm" disabled={busy || !address.trim() || !code.trim()}>
              {busy ? "Pairing…" : "Pair"}
            </Button>
          </div>
        </form>
      )}
      {said && (
        <p role="alert" className="mt-2 text-[11px] text-destructive">
          {said}
        </p>
      )}
    </section>
  );
}

/** A run handed over from this chat, as the chat shows it. */
export interface HulkRunView {
  requestId: string;
  task: string;
  look: HandoverLook | null;
  note: string | null;
  branch: string | null;
}

/** "Running on HULK" cards above the composer, one per run this chat handed over. */
export function HulkRuns({ runs, address }: { runs: HulkRunView[]; address: string | null }) {
  if (runs.length === 0) return null;
  return (
    <ul className="mx-auto mb-2 w-full max-w-[716px] space-y-1.5 px-4" aria-label="Runs on HULK">
      {runs.map((r) => (
        <li
          key={r.requestId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs"
        >
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Running on HULK: {r.task}</span>
          <span
            role="status"
            className={r.look === "failed" ? "text-destructive" : "text-muted-foreground"}
          >
            {r.look ? LOOK_LABEL[r.look] : "Checking…"}
            {r.branch ? ` · ${r.branch}` : ""}
            {r.note && (r.look === "failed" || r.look === "done" || r.look === "stopped")
              ? ` · ${r.note}`
              : ""}
          </span>
          {address && (
            <button
              type="button"
              className="flex items-center gap-1 text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                openExternal(address);
              }}
            >
              Open HULK
              <ExternalLink className="size-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
