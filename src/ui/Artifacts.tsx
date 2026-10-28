import { Check, Code2, Copy, FileText, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
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

/** The side panel with one artifact (AR-01). */
export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: ArtifactView;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
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
            {artifact.version === null ? " · writing…" : ` · version ${String(artifact.version)}`}
          </span>
        </span>
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
        <Button variant="ghost" size="icon-sm" aria-label="Close artifact" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {artifact.type === "markdown" ? (
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
