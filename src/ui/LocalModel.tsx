import { Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openExternal } from "./openExternal";

/** Settings → Local model (M7, LL-03): what this computer can run, and which model it gets. */
export interface LocalModelView {
  /** e.g. "14.0 GB memory (9.2 GB free) · 8 CPUs · AVX2 · 120.4 GB free disk" */
  computer: string;
  reason: string;
  warning: string | null;
  profile: {
    name: string;
    file: string;
    /** e.g. "Q8_0 · 1.8 GB download · about 2.6 GB of memory" */
    detail: string;
    licence: string;
    licenceUrl: string;
    sourceUrl: string;
  } | null;
  /** The recommended profile's file (absent when there's no profile). */
  install?: {
    status: "missing" | "installed" | "update" | "downloading" | "verifying";
    /** Bytes, while downloading. */
    progress: { done: number; total: number } | null;
    error: string | null;
  };
  /** Other model files on this computer (e.g. from before the hardware changed). */
  others?: { file: string; label: string }[];
}

const pct = (p: { done: number; total: number }) =>
  `${String(Math.floor((p.done / Math.max(1, p.total)) * 100))}%`;

export function LocalModelSection({
  view,
  error = null,
  onInstall,
  onPause,
  onRemove,
  enabled = true,
  onEnabled,
  shadow = null,
}: {
  view: LocalModelView | null;
  error?: string | null;
  onInstall?: () => void;
  onPause?: () => void;
  onRemove?: (file: string) => void;
  /** LL-04: whether housekeeping uses it; off sends everything back to the cloud at once. */
  enabled?: boolean;
  onEnabled?: (on: boolean) => void;
  /** LL-09: what the shadow checks found, or that they're on. */
  shadow?: string | null;
}) {
  const job = view?.install;
  return (
    <section className="mt-8 border-t pt-6" aria-label="Local model">
      <div className="mb-1 flex items-center gap-2">
        <Cpu className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Local model</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        A small model that runs on this computer for FUSE&apos;s own housekeeping (chat titles,
        summaries, memory suggestions), at no API cost. It never writes the answers you read, and
        FUSE works the same without it.
      </p>
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : !view ? (
        <p className="text-[11px] text-muted-foreground">Checking this computer…</p>
      ) : (
        <div className="space-y-2 text-[11px] leading-5">
          <p className="text-muted-foreground">This computer: {view.computer}</p>
          <p>{view.reason}</p>
          {view.warning && <p className="text-amber-700 dark:text-amber-400">{view.warning}</p>}
          {view.profile && (
            <div className="rounded-lg border p-3">
              <p className="font-medium">{view.profile.name}</p>
              <p className="text-muted-foreground">{view.profile.detail}</p>
              <p className="text-muted-foreground">
                Licence:{" "}
                <button
                  className="underline underline-offset-2"
                  onClick={() => {
                    openExternal(view.profile?.licenceUrl ?? "");
                  }}
                >
                  {view.profile.licence}
                </button>
                {" · "}
                <button
                  className="underline underline-offset-2"
                  onClick={() => {
                    openExternal(view.profile?.sourceUrl ?? "");
                  }}
                >
                  Source
                </button>
              </p>
              {job && (
                <div className="mt-2 space-y-1.5">
                  {job.status === "downloading" || job.status === "verifying" ? (
                    <>
                      <div
                        className="h-1.5 overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-label="Download"
                        aria-valuenow={
                          job.progress
                            ? Math.floor(
                                (job.progress.done / Math.max(1, job.progress.total)) * 100,
                              )
                            : 0
                        }
                      >
                        <div
                          className="h-full bg-foreground/70"
                          style={{ width: job.progress ? pct(job.progress) : "0%" }}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-muted-foreground">
                        <span>
                          {job.status === "verifying"
                            ? "Checking the file…"
                            : job.progress
                              ? `Downloading ${pct(job.progress)} (${(job.progress.done / 1e9).toFixed(2)} of ${(job.progress.total / 1e9).toFixed(2)} GB)`
                              : "Starting…"}
                        </span>
                        {job.status === "downloading" && onPause && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={onPause}
                          >
                            Pause
                          </Button>
                        )}
                      </div>
                    </>
                  ) : job.status === "installed" ? (
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {enabled
                          ? "Installed and checked. FUSE uses it first for titles, summaries, memory suggestions and second opinions on routing, and falls back to a cheap cloud model if it fails."
                          : "Installed and checked, but turned off: housekeeping goes to a cheap cloud model."}
                      </span>
                      {onRemove && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            onRemove(view.profile?.file ?? "");
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">
                        {job.status === "update"
                          ? "A newer build of this model is available."
                          : "Downloaded from Hugging Face and checked against its SHA-256 before use."}
                      </span>
                      {onInstall && (
                        <Button size="sm" className="h-7 text-xs" onClick={onInstall}>
                          {job.status === "update" ? "Update" : "Download and install"}
                        </Button>
                      )}
                    </div>
                  )}
                  {job.status === "installed" && onEnabled && (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => {
                          onEnabled(e.target.checked);
                        }}
                      />
                      Use the local model for housekeeping
                    </label>
                  )}
                  {job.status === "installed" && shadow && (
                    <p className="text-muted-foreground">{shadow}</p>
                  )}
                  {job.error && <p className="text-destructive">{job.error}</p>}
                </div>
              )}
            </div>
          )}
          {view.others && view.others.length > 0 && (
            <ul className="space-y-1">
              {view.others.map((o) => (
                <li key={o.file} className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Also on this computer: {o.label}</span>
                  {onRemove && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        onRemove(o.file);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
