import { HardDrive } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes, type StoragePart, type StorageRow } from "@/data/storage";

export interface StorageApi {
  load: () => Promise<StorageRow[]>;
  /** Runs one part's clean-up; resolves to a line to show. */
  clean: (part: StoragePart) => Promise<string>;
}

/**
 * M10 step 20 (review item 18): what FUSE keeps on this computer, by part, each with a
 * clean-up where one is safe. Spend totals never change: the request log is only trimmed past
 * the usage windows, and messages keep their own costs.
 */
export function Storage({ api }: { api: StorageApi }) {
  const [rows, setRows] = useState<StorageRow[] | null>(null);
  const [busy, setBusy] = useState<StoragePart | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api.load().then(setRows, (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  useEffect(() => {
    let alive = true;
    api.load().then(
      (r) => {
        if (alive) setRows(r);
      },
      (e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [api]);
  return (
    <div role="group" aria-label="Storage" className="mt-5">
      <div className="mb-1 flex items-center gap-2">
        <HardDrive className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-medium">Storage</h3>
      </div>
      <p className="mb-2 text-[11px] leading-5 text-muted-foreground">
        What FUSE keeps on this computer. A clean-up never touches your chats or what they cost.
      </p>
      {rows === null && !error && <p className="text-[11px] text-muted-foreground">Measuring…</p>}
      {rows && (
        <table className="w-full max-w-xl text-xs">
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-1.5 pr-3">{r.label}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                  {r.bytes !== null ? formatBytes(r.bytes) : ""}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                  {r.count.toLocaleString("en-US")} {r.id === "attachments" ? "files" : "rows"}
                </td>
                <td className="py-1.5 text-right">
                  {r.cleanup && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[11px]"
                      disabled={busy !== null}
                      title={r.cleanup}
                      onClick={() => {
                        setBusy(r.id);
                        setStatus(null);
                        setError(null);
                        api.clean(r.id).then(
                          (line) => {
                            setBusy(null);
                            setStatus(line);
                            void load();
                          },
                          (e: unknown) => {
                            setBusy(null);
                            setError(e instanceof Error ? e.message : String(e));
                          },
                        );
                      }}
                    >
                      {busy === r.id ? "Cleaning…" : r.cleanup}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {status && (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
