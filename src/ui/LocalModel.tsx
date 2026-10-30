import { Cpu } from "lucide-react";
import { openExternal } from "./openExternal";

/** Settings → Local model (M7, LL-03): what this computer can run, and which model it gets. */
export interface LocalModelView {
  /** e.g. "14.0 GB memory (9.2 GB free) · 8 CPUs · AVX2 · 120.4 GB free disk" */
  computer: string;
  reason: string;
  warning: string | null;
  profile: {
    name: string;
    /** e.g. "Q8_0 · 1.8 GB download · about 2.6 GB of memory" */
    detail: string;
    licence: string;
    licenceUrl: string;
    sourceUrl: string;
  } | null;
}

export function LocalModelSection({
  view,
  error = null,
}: {
  view: LocalModelView | null;
  error?: string | null;
}) {
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
            </div>
          )}
        </div>
      )}
    </section>
  );
}
