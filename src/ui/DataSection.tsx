import { Database, Download, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Settings → Your data (SE-07): export everything; delete-all comes with step 6. */
export function DataSection({
  onExport,
  children,
}: {
  /** Builds and saves the export; returns a line to show, or null if cancelled. */
  onExport: () => Promise<string | null>;
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  return (
    <section className="mt-8 border-t pt-6" aria-label="Your data">
      <div className="mb-1 flex items-center gap-2">
        <Database className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Your data</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Export everything FUSE keeps as one zip: all chats (with every branch) as JSON and as
        Markdown, memories, projects, artifacts with their versions, instructions, budgets, usage
        and your attached files. API keys are never included.
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setStatus(null);
          onExport().then(
            (line) => {
              setBusy(false);
              if (line) setStatus(line);
            },
            (e: unknown) => {
              setBusy(false);
              setStatus(e instanceof Error ? e.message : String(e));
            },
          );
        }}
      >
        {busy ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Download className="size-3.5" />
        )}
        Export everything…
      </Button>
      {status && (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {status}
        </p>
      )}
      {children}
    </section>
  );
}
