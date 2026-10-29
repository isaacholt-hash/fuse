import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PAGE_MARKER } from "@/files/pdfText";
import { Button } from "@/components/ui/button";

export interface FileViewerView {
  name: string;
  kind: "image" | "pdf" | "text";
  /** Images: a blob: URL. */
  url?: string;
  /** Text files (and long PDFs read as text). */
  text?: string;
  /** PDFs sent as PDFs. */
  bytes?: Uint8Array;
  /** The cited place: a page (PDFs) or a line range (text). */
  focus?: { page?: number; lineStart?: number; lineEnd?: number };
}

/** The side panel showing an attached file (FK-10), at the place an answer cited. */
export function FileViewer({ file, onClose }: { file: FileViewerView; onClose: () => void }) {
  return (
    <aside
      className="flex h-full w-[min(560px,45vw)] shrink-0 flex-col border-l bg-background max-[900px]:w-full"
      aria-label={`File: ${file.name}`}
    >
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b px-4">
        <FileText className="size-4 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{file.name}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Close file" onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {file.kind === "image" && file.url ? (
          <img src={file.url} alt={file.name} className="mx-auto max-w-full p-4" />
        ) : file.kind === "pdf" && file.bytes ? (
          <PdfPages bytes={file.bytes} page={file.focus?.page ?? 1} />
        ) : (
          <TextLines text={file.text ?? ""} focus={file.focus} />
        )}
      </div>
    </aside>
  );
}

/** Numbered lines; the cited ones (or the cited page's) highlighted and scrolled to. */
function TextLines({ text, focus }: { text: string; focus: FileViewerView["focus"] }) {
  const lines = text.split("\n");
  // A page in a long PDF's text runs from its marker to the next one.
  let from = focus?.lineStart ?? null;
  let to = focus?.lineEnd ?? from;
  if (focus?.page !== undefined) {
    const start = lines.findIndex((l) => PAGE_MARKER.exec(l)?.[1] === String(focus.page));
    if (start >= 0) {
      const next = lines.findIndex((l, i) => i > start && PAGE_MARKER.test(l));
      from = start + 1;
      to = next === -1 ? lines.length : next;
    }
  }
  const first = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- jsdom has no scrollIntoView
    first.current?.scrollIntoView?.({ block: "center" });
  }, [from]);
  return (
    <pre className="py-3 font-mono text-[12px] leading-6" aria-label="File text">
      {lines.map((line, i) => {
        const n = i + 1;
        const hit = from !== null && to !== null && n >= from && n <= to;
        return (
          <span
            key={n}
            ref={hit && n === from ? first : undefined}
            data-cited={hit || undefined}
            className={`block px-4 whitespace-pre-wrap ${hit ? "bg-amber-200/50 dark:bg-amber-500/20" : ""}`}
          >
            <span className="mr-3 inline-block w-8 text-right text-muted-foreground select-none">
              {n}
            </span>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

/** A PDF page drawn with PDF.js (bundled, no network), with previous and next. */
function PdfPages({ bytes, page: start }: { bytes: Uint8Array; page: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(start);
  const [pages, setPages] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const run = { cancelled: false };
    void (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([
          import("pdfjs-dist"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdfjs.getDocument({ data: bytes.slice() });
        const doc = await task.promise;
        if (run.cancelled) return;
        setPages(doc.numPages);
        const p = await doc.getPage(Math.min(Math.max(page, 1), doc.numPages));
        const viewport = p.getViewport({ scale: 1.4 });
        const el = canvas.current;
        const context = el?.getContext("2d");
        if (!el || !context) return;
        el.width = viewport.width;
        el.height = viewport.height;
        await p.render({ canvas: el, canvasContext: context, viewport }).promise;
        await task.destroy();
      } catch (e) {
        if (!run.cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      run.cancelled = true;
    };
  }, [bytes, page]);
  if (error)
    return <p className="p-4 text-xs text-destructive">Couldn&apos;t show this PDF: {error}</p>;
  return (
    <div className="flex flex-col items-center gap-2 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => {
            setPage((n) => n - 1);
          }}
        >
          <ChevronLeft />
        </Button>
        Page {page}
        {pages !== null && ` of ${String(pages)}`}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next page"
          disabled={pages !== null && page >= pages}
          onClick={() => {
            setPage((n) => n + 1);
          }}
        >
          <ChevronRight />
        </Button>
      </div>
      <canvas
        ref={canvas}
        className="max-w-full rounded border bg-white"
        aria-label={`Page ${String(page)}`}
      />
    </div>
  );
}
