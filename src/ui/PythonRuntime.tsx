// Settings → Python for data work (M9 step 5, AG-03): install it when you want it, see what's
// there, remove it. Nothing runs scripts until step 6.
import { FileCode2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface PythonRuntimeView {
  /** null on a computer FUSE has no build for. */
  offer: { python: string; downloadMb: number; libraries: string[] } | null;
  installed: { python: string; sizeMb: number; libraries: number } | null;
  job: {
    step: "downloading" | "verifying" | "unpacking" | "libraries";
    percent: number | null;
  } | null;
  error: string | null;
}

const STEP = {
  downloading: "Downloading Python",
  verifying: "Checking the download",
  unpacking: "Unpacking",
  libraries: "Installing the libraries from PyPI (each checked against its hash)",
};

export function PythonRuntimeSection({
  view,
  onInstall,
  onStop,
  onRemove,
}: {
  view: PythonRuntimeView;
  onInstall: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const { offer, installed, job, error } = view;
  return (
    <section className="mt-8 border-t pt-6" aria-label="Python for data work">
      <div className="mb-1 flex items-center gap-2">
        <FileCode2 className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Python for data work</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Lets Work runs analyse spreadsheets and CSVs and make charts with Python, in the same
        sandbox as commands. It&apos;s downloaded only if you install it, and kept in FUSE&apos;s
        own folder; your own Python, if you have one, isn&apos;t touched.
      </p>
      <div className="space-y-2 text-[11px] leading-5">
        {!offer && !installed && (
          <p className="text-muted-foreground">
            FUSE has no Python build for this computer yet (Windows and Linux on x86-64 only).
          </p>
        )}
        {installed && !job && (
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <div className="flex-1">
              <p className="font-medium">Python {installed.python} is installed</p>
              <p className="text-muted-foreground">
                {String(installed.libraries)} libraries · {String(installed.sizeMb)} MB on disk
              </p>
            </div>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onRemove}>
              Remove
            </Button>
          </div>
        )}
        {offer && !installed && !job && (
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <div className="flex-1">
              <p className="font-medium">Python {offer.python}</p>
              <p className="text-muted-foreground">
                With {offer.libraries.join(", ")}. A {String(offer.downloadMb)} MB download, then
                the libraries from PyPI.
              </p>
            </div>
            <Button size="sm" className="h-7 text-xs" onClick={onInstall}>
              Install
            </Button>
          </div>
        )}
        {job && (
          <div className="flex items-center gap-3 rounded-lg border p-3" role="status">
            <p className="flex-1">
              {STEP[job.step]}
              {job.percent !== null ? ` · ${String(job.percent)}%` : "…"}
            </p>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onStop}>
              Stop
            </Button>
          </div>
        )}
        {error && <p className="text-destructive">{error}</p>}
      </div>
    </section>
  );
}
