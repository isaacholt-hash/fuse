import {
  Check,
  Code2,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { asPage, mermaidSvg, reactPage, svgDataUrl, type PreviewApi } from "@/artifacts/preview";
import { Button } from "@/components/ui/button";
import { CodeBlock, Markdown } from "./Markdown";

export interface ArtifactView {
  key: string;
  title: string;
  type: "markdown" | "code" | "html" | "svg" | "mermaid" | "react";
  language: string;
  content: string;
  /** Saved version number; null while it's still being written. */
  version: number | null;
  /** AR-05: the preview may load the listed CDNs. */
  allowCdn?: boolean;
}

const KIND: Record<ArtifactView["type"], string> = {
  markdown: "Document",
  code: "Code",
  html: "Web page",
  svg: "Image (SVG)",
  mermaid: "Diagram",
  react: "React component",
};

/** The card an artifact leaves in the chat; opens it in the side panel. */
export function ArtifactCard({
  title,
  type,
  language,
  writing,
  open,
  onOpen,
}: {
  title: string;
  type: ArtifactView["type"];
  language: string;
  writing: boolean;
  open: boolean;
  onOpen: () => void;
}) {
  const Icon = type === "markdown" ? FileText : Code2;
  return (
    <button
      className={`my-4 flex w-full max-w-md items-center gap-3 rounded-xl border px-4 py-3 text-left hover:bg-accent ${open ? "border-ring" : ""}`}
      aria-label={`Open ${title}`}
      onClick={onOpen}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        {writing ? <LoaderCircle className="size-4 animate-spin" /> : <Icon className="size-4" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{title}</span>
        <span className="block text-[11px] text-muted-foreground">
          {writing ? "Writing…" : `${KIND[type]}${language ? ` · ${language}` : ""} · open`}
        </span>
      </span>
    </button>
  );
}

/** One saved version, for the picker (AR-02). */
export interface VersionView {
  version: number;
  /** "AI", "You" or "Restored" */
  by: string;
  when: string;
}

export interface VersionsProps {
  versions: VersionView[];
  /** The version on screen; null = the latest. */
  shown: number | null;
  /** Shown as a diff against this version; null = no diff. */
  compareWith: number | null;
  diff: { kind: "same" | "add" | "del"; text: string }[] | null;
  onShow: (version: number | null) => void;
  onCompare: (version: number | null) => void;
  onRestore: (version: number) => void;
  onSaveEdit: (content: string) => void;
  /** AR-03: asks the model to change the selection (or the whole artifact when it's empty). */
  onAskEdit?: (selection: string, instruction: string) => void;
}

export function DiffView({ lines }: { lines: NonNullable<VersionsProps["diff"]> }) {
  return (
    <pre
      className="overflow-x-auto rounded-lg border font-mono text-[12px] leading-6"
      aria-label="Changes"
    >
      {lines.map((l, i) => (
        <span
          key={i}
          className={`block px-3 ${l.kind === "add" ? "bg-emerald-500/15" : l.kind === "del" ? "bg-destructive/10 text-muted-foreground line-through" : ""}`}
        >
          <span
            className="mr-3 inline-block w-3 text-muted-foreground select-none"
            aria-hidden="true"
          >
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
          </span>
          {l.text || " "}
        </span>
      ))}
    </pre>
  );
}

/** Types that have a live preview (AR-05). */
const PREVIEWABLE: ReadonlySet<ArtifactView["type"]> = new Set(["html", "svg", "mermaid", "react"]);
/** Types whose preview runs as a page, where the CDN switch applies. */
const PAGE_TYPES: ReadonlySet<ArtifactView["type"]> = new Set(["html", "react"]);

/** The rendered artifact: HTML and React in a no-network sandbox, SVG and Mermaid as images. */
function Preview({ artifact, api }: { artifact: ArtifactView; api: PreviewApi }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const dark = document.documentElement.classList.contains("dark");
    const cdn = { cdn: artifact.allowCdn ?? false };
    const job =
      artifact.type === "html"
        ? api.url(asPage(artifact.content), cdn)
        : artifact.type === "react"
          ? reactPage(artifact.content).then((page) => api.url(page, cdn))
          : artifact.type === "svg"
            ? Promise.resolve(svgDataUrl(artifact.content))
            : mermaidSvg(artifact.content, dark).then(svgDataUrl);
    job.then(
      (url) => {
        if (current) setSrc(url);
      },
      (e: unknown) => {
        if (current) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [artifact.type, artifact.content, artifact.allowCdn, api]);
  if (error) {
    return (
      <p role="alert" className="text-[12px] text-destructive">
        Couldn&apos;t show a preview: {error}
      </p>
    );
  }
  if (!src) return <p className="text-[12px] text-muted-foreground">Rendering…</p>;
  return PAGE_TYPES.has(artifact.type) ? (
    <iframe
      title={`Preview of ${artifact.title}`}
      src={src}
      // Scripts run, but in an opaque origin: no access to the app, its storage or its keys.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="h-full min-h-[480px] w-full rounded-lg border bg-white"
    />
  ) : (
    <img src={src} alt={artifact.title} className="mx-auto max-w-full rounded-lg bg-white p-2" />
  );
}

/** The side panel with one artifact (AR-01), its versions, diffs and edits (AR-02). */
export function ArtifactPanel({
  artifact,
  onClose,
  versions,
  preview,
  onExport,
  onAllowCdn,
}: {
  artifact: ArtifactView;
  onClose: () => void;
  versions?: VersionsProps;
  /** Live previews (AR-05); without it everything shows as code. */
  preview?: PreviewApi;
  /** AR-04: saves the artifact (natural file, or .docx/.pdf for Markdown); the saved name or null. */
  onExport?: (format: "file" | "docx" | "pdf") => Promise<string | null>;
  /** AR-05: lets this artifact's preview load the listed CDNs. */
  onAllowCdn?: (allow: boolean) => void;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const doExport = (format: "file" | "docx" | "pdf") => {
    setExportOpen(false);
    onExport?.(format).then(
      (name) => {
        if (name) setSaved(`Saved ${name}`);
      },
      (e: unknown) => {
        setSaved(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const canPreview = Boolean(preview) && PREVIEWABLE.has(artifact.type);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // AR-03: the text selected in the panel when "Ask AI" was opened, and the instruction.
  const [asking, setAsking] = useState<{ selection: string; instruction: string } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const selectedText = () => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    return sel && node && body.current?.contains(node) ? sel.toString().trim() : "";
  };
  const latest = versions?.versions.at(-1)?.version ?? artifact.version;
  const shown = versions?.shown ?? latest;
  const old = shown !== null && latest !== null && shown < latest;
  return (
    <aside
      className="flex w-[46%] max-w-[760px] min-w-[340px] shrink-0 flex-col border-l bg-background"
      aria-label={`Artifact: ${artifact.title}`}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{artifact.title}</span>
          <span className="block text-[10px] text-muted-foreground">
            {KIND[artifact.type]}
            {artifact.language ? ` · ${artifact.language}` : ""}
            {artifact.version === null
              ? " · writing…"
              : ` · version ${String(shown ?? artifact.version)}`}
          </span>
        </span>
        {versions && artifact.version !== null && draft === null && (
          <>
            {versions.versions.length > 1 && (
              <select
                aria-label="Version"
                className="h-7 rounded-md border border-input bg-background px-1.5 text-[11px]"
                value={String(shown)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  versions.onShow(v === latest ? null : v);
                }}
              >
                {[...versions.versions].reverse().map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version} · {v.by} · {v.when}
                    {v.version === latest ? " (latest)" : ""}
                  </option>
                ))}
              </select>
            )}
            {versions.versions.length > 1 && (
              <select
                aria-label="Compare with"
                className="h-7 rounded-md border border-input bg-background px-1.5 text-[11px]"
                value={versions.compareWith === null ? "" : String(versions.compareWith)}
                onChange={(e) => {
                  versions.onCompare(e.target.value === "" ? null : Number(e.target.value));
                }}
              >
                <option value="">No diff</option>
                {versions.versions
                  .filter((v) => v.version !== shown)
                  .map((v) => (
                    <option key={v.version} value={v.version}>
                      Diff with v{v.version}
                    </option>
                  ))}
              </select>
            )}
            {old && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => {
                  versions.onRestore(shown);
                }}
              >
                <RotateCcw className="size-3.5" />
                Restore
              </Button>
            )}
            {!old && versions.onAskEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                aria-label="Ask AI to edit"
                onMouseDown={(e) => {
                  e.preventDefault(); // keep the selection
                }}
                onClick={() => {
                  setAsking({ selection: selectedText(), instruction: "" });
                }}
              >
                <Sparkles className="size-3.5" />
                Ask AI
              </Button>
            )}
            {!old && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Edit artifact"
                onClick={() => {
                  setDraft(artifact.content);
                }}
              >
                <Pencil />
              </Button>
            )}
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy artifact"
          onClick={() => {
            void navigator.clipboard.writeText(artifact.content).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
        {canPreview && (
          <span
            className="flex rounded-md border p-0.5 text-[11px]"
            role="tablist"
            aria-label="View"
          >
            {(["preview", "code"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={`rounded px-2 py-0.5 ${tab === t ? "bg-accent font-medium" : "text-muted-foreground"}`}
                onClick={() => {
                  setTab(t);
                }}
              >
                {t === "preview" ? "Preview" : "Code"}
              </button>
            ))}
          </span>
        )}
        {canPreview && tab === "preview" && onAllowCdn && PAGE_TYPES.has(artifact.type) && (
          <label
            className="flex items-center gap-1 text-[11px] text-muted-foreground"
            title="Let this preview load scripts and styles from cdnjs, jsDelivr and unpkg. Off: nothing leaves the preview."
          >
            <input
              type="checkbox"
              checked={artifact.allowCdn ?? false}
              onChange={(e) => {
                onAllowCdn(e.target.checked);
              }}
            />
            CDNs
          </label>
        )}
        {onExport && artifact.version !== null && (
          <span className="relative">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Export artifact"
              aria-expanded={exportOpen}
              onClick={() => {
                setExportOpen((o) => !o);
              }}
            >
              <Download />
            </Button>
            {exportOpen && (
              <span
                role="menu"
                className="absolute top-8 right-0 z-20 flex w-44 flex-col rounded-lg border bg-popover p-1 text-[12px] shadow-lg"
              >
                <button
                  role="menuitem"
                  className="rounded px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    doExport("file");
                  }}
                >
                  Save as file…
                </button>
                {artifact.type === "markdown" && (
                  <>
                    <button
                      role="menuitem"
                      className="rounded px-2 py-1.5 text-left hover:bg-accent"
                      onClick={() => {
                        doExport("docx");
                      }}
                    >
                      Save as Word (.docx)…
                    </button>
                    <button
                      role="menuitem"
                      className="rounded px-2 py-1.5 text-left hover:bg-accent"
                      onClick={() => {
                        doExport("pdf");
                      }}
                    >
                      Save as PDF…
                    </button>
                  </>
                )}
              </span>
            )}
          </span>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close artifact" onClick={onClose}>
          <X />
        </Button>
      </div>
      {saved && (
        <p
          role="status"
          className="border-b bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground"
        >
          {saved}
        </p>
      )}
      {asking && versions?.onAskEdit && (
        <form
          className="border-b bg-muted/30 px-4 py-3"
          aria-label="Ask AI to edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (!asking.instruction.trim()) return;
            versions.onAskEdit?.(asking.selection, asking.instruction.trim());
            setAsking(null);
          }}
        >
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            {asking.selection
              ? `Change the selected part (${String(asking.selection.length)} characters):`
              : "Change the whole artifact (select text first to change just a part):"}
          </p>
          <div className="flex gap-2">
            <input
              aria-label="What should change"
              autoFocus
              placeholder="e.g. make this shorter and friendlier"
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
              value={asking.instruction}
              onChange={(e) => {
                setAsking({ ...asking, instruction: e.target.value });
              }}
            />
            <Button type="submit" size="sm" disabled={!asking.instruction.trim()}>
              Send
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAsking(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {draft !== null && versions ? (
          <div className="flex h-full flex-col gap-2">
            <textarea
              aria-label="Artifact content"
              className="min-h-0 flex-1 resize-none rounded-lg border bg-background p-3 font-mono text-[12px] leading-6 outline-none focus:border-ring"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(null);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  versions.onSaveEdit(draft);
                  setDraft(null);
                }}
              >
                Save as a new version
              </Button>
            </div>
          </div>
        ) : versions?.diff ? (
          <DiffView lines={versions.diff} />
        ) : canPreview && preview && tab === "preview" && artifact.version !== null ? (
          <Preview artifact={artifact} api={preview} />
        ) : artifact.type === "markdown" ? (
          <div className="text-[13px] leading-[1.85] text-foreground/85">
            <Markdown content={artifact.content} />
          </div>
        ) : (
          <CodeBlock language={artifact.language || artifact.type} code={artifact.content} />
        )}
      </div>
    </aside>
  );
}
