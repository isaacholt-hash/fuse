import { FlaskConical, LoaderCircle, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export interface GoldenSetSummary {
  total: number;
  balanced: number;
  best: number;
  needsContext: number;
}

const SHOWN_ERRORS = 5;

/** Settings → Routing test set (RT-16): import real prompts with the tier you expect. */
export function GoldenSetSection({
  summary,
  onImport,
}: {
  summary: GoldenSetSummary;
  /** Imports a JSON Lines file's text; returns the problems, empty when it was saved. */
  onImport: (text: string) => Promise<string[]>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [imported, setImported] = useState(false);

  const read = async (file: File) => {
    setBusy(true);
    setImported(false);
    try {
      const problems = await onImport(await file.text());
      setErrors(problems);
      setImported(problems.length === 0);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8 border-t pt-6" aria-label="Routing test set">
      <div className="mb-1 flex items-center gap-2">
        <FlaskConical className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Routing test set</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Real prompts with the tier you&apos;d expect. Auto routing is checked against them. Import a
        .jsonl file, one prompt per line. Importing replaces the current set, and the prompts stay
        on this computer.
      </p>
      <div className="flex items-center gap-3">
        <p className="flex-1 text-xs" role="status">
          {summary.total === 0
            ? "No prompts yet."
            : `${String(summary.total)} prompts · ${String(summary.balanced)} Balanced · ${String(summary.best)} Best` +
              (summary.needsContext > 0
                ? ` · ${String(summary.needsContext)} need earlier context`
                : "")}
          {imported && <span className="ml-2 text-muted-foreground">Imported.</span>}
        </p>
        <input
          ref={input}
          type="file"
          accept=".jsonl,.json,.txt"
          className="hidden"
          aria-label="Test set file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void read(file);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            input.current?.click();
          }}
        >
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Upload className="size-3.5" />
          )}
          Import
        </Button>
      </div>
      {errors.length > 0 && (
        <div className="mt-2 text-[11px] text-destructive" role="alert">
          <p>Nothing was imported:</p>
          <ul className="mt-1 list-disc pl-4">
            {errors.slice(0, SHOWN_ERRORS).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          {errors.length > SHOWN_ERRORS && (
            <p className="mt-1">…and {String(errors.length - SHOWN_ERRORS)} more.</p>
          )}
        </div>
      )}
    </section>
  );
}
