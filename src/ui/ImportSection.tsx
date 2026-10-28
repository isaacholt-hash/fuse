import { FileDown, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export interface ImportSourceView {
  id: string;
  /** e.g. "ChatGPT" */
  label: string;
  /** What to pick, e.g. "the export zip from Settings → Data controls → Export data". */
  hint: string;
  accept: string;
}

export interface ImportPreviewView {
  chats: number;
  messages: number;
  already: number;
  /** Projects in the export (Claude), made or filled in by name. */
  projects?: number;
}

/** Settings → Import (PL-08): chats from ChatGPT and Claude, previewed before anything is written. */
export function ImportSection({
  sources,
  onRead,
  onImport,
  children,
}: {
  sources: ImportSourceView[];
  /** Reads the picked file; what would be imported. */
  onRead: (source: string, file: File) => Promise<ImportPreviewView>;
  /** Imports what was last read; returns how many chats were written. */
  onImport: (onProgress: (done: number, total: number) => void) => Promise<number>;
  children?: React.ReactNode;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<ImportSourceView | null>(null);
  const [preview, setPreview] = useState<ImportPreviewView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  return (
    <section className="mt-8 border-t pt-6" aria-label="Import">
      <div className="mb-1 flex items-center gap-2">
        <FileDown className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Import</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Bring your chats over from another app&apos;s data export. You see what will come in first;
        importing again later only adds chats that are new.
      </p>
      <input
        ref={picker}
        type="file"
        className="hidden"
        aria-label="Export file"
        accept={source?.accept}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file || !source) return;
          setBusy("Reading…");
          setStatus(null);
          setPreview(null);
          onRead(source.id, file).then(
            (p) => {
              setBusy(null);
              setPreview(p);
            },
            (err: unknown) => {
              setBusy(null);
              setStatus(err instanceof Error ? err.message : String(err));
            },
          );
        }}
      />
      <div className="flex flex-wrap gap-2">
        {sources.map((s) => (
          <Button
            key={s.id}
            variant="outline"
            size="sm"
            disabled={busy !== null}
            title={s.hint}
            onClick={() => {
              setSource(s);
              // The picker opens after the accept filter for this source is applied.
              setTimeout(() => picker.current?.click(), 0);
            }}
          >
            From {s.label}…
          </Button>
        ))}
      </div>
      {source && !preview && !busy && !status && (
        <p className="mt-2 text-[11px] text-muted-foreground">Pick {source.hint}.</p>
      )}
      {busy && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" />
          {busy}
        </p>
      )}
      {preview && source && !busy && (
        <div className="mt-3 rounded-lg border p-3 text-xs" aria-label="Import preview">
          <p>
            {preview.chats === 0
              ? "Nothing new to import."
              : `${String(preview.chats)} chats (${preview.messages.toLocaleString("en-US")} messages) from ${source.label}.`}
            {preview.projects
              ? ` ${String(preview.projects)} projects with their instructions and documents.`
              : ""}
            {preview.already > 0 && (
              <span className="text-muted-foreground">
                {" "}
                {String(preview.already)} already imported, skipped.
              </span>
            )}
          </p>
          {preview.chats > 0 && (
            <Button
              size="sm"
              className="mt-2"
              onClick={() => {
                setBusy("Importing…");
                onImport((done, total) => {
                  setBusy(`Importing… ${String(done)} of ${String(total)}`);
                }).then(
                  (n) => {
                    setBusy(null);
                    setPreview(null);
                    setStatus(`Imported ${String(n)} chats.`);
                  },
                  (err: unknown) => {
                    setBusy(null);
                    setStatus(err instanceof Error ? err.message : String(err));
                  },
                );
              }}
            >
              Import {String(preview.chats)} chats
            </Button>
          )}
        </div>
      )}
      {status && (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {status}
        </p>
      )}
      {children}
    </section>
  );
}
