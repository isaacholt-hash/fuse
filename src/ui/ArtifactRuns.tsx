import { Play, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** One attempt, for the output beside the code (M17.3, AR-08). */
export interface RunView {
  id: string;
  attempt: number;
  /** The version number it ran. */
  version: number;
  state: "requested" | "running" | "complete" | "failed" | "stopped" | "interrupted";
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  elapsedMs: number | null;
  output: string;
  inputs: { name: string; bytes: number }[];
  outputs: { path: string; sha256: string; bytes: number }[];
  scriptSha256: string;
}

export interface RunsProps {
  runs: RunView[];
  /** The version on screen, which is the one that runs. */
  version: number;
  scriptSha256: string;
  /** Why it can't run here (no runtime, no sandbox, no exec); null when it can. */
  unavailable: string | null;
  running: boolean;
  /** Live output of the run going now. */
  live: string;
  onRun: (inputs: File[]) => void;
  onStop: () => void;
  /** A viewable URL for an output image. */
  imageUrl?: (sha256: string) => Promise<string>;
}

const LIMITS = "No network · up to 120 s · 512 MB memory · up to 50 output files (20 MB)";

const size = (n: number) =>
  n < 1024
    ? `${String(n)} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

function stateText(r: RunView): string {
  switch (r.state) {
    case "requested":
    case "running":
      return "Running…";
    case "complete":
      return `Finished (exit ${String(r.exitCode ?? 0)})`;
    case "failed":
      return r.timedOut
        ? "Stopped at the time limit"
        : r.exitCode === null
          ? "Didn't run"
          : `Failed (exit ${String(r.exitCode)})`;
    case "stopped":
      return "Stopped";
    case "interrupted":
      return "Interrupted: the app closed while it ran";
  }
}

/** The approval for one run: exactly this version and these inputs, once. */
export function RunApproval({
  version,
  scriptSha256,
  onAllow,
  onCancel,
}: {
  version: number;
  scriptSha256: string;
  onAllow: (inputs: File[]) => void;
  onCancel: () => void;
}) {
  const [inputs, setInputs] = useState<File[]>([]);
  return (
    <div
      role="alertdialog"
      aria-label="Run this Python script?"
      className="border-b bg-muted/30 px-4 py-3 text-[12px]"
    >
      <p className="font-medium">Run this Python script?</p>
      <p className="mt-1 text-muted-foreground">
        Version {version} · SHA-256 <span className="font-mono">{scriptSha256.slice(0, 12)}</span>
      </p>
      <p className="mt-1 text-muted-foreground">{LIMITS}</p>
      <label className="mt-2 block text-muted-foreground">
        Input files (optional, read-only as <span className="font-mono">inputs/&lt;name&gt;</span>
        ):
        <input
          type="file"
          multiple
          aria-label="Input files"
          className="mt-1 block text-[11px]"
          onChange={(e) => {
            setInputs([...(e.target.files ?? [])]);
          }}
        />
      </label>
      {inputs.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          {inputs.map((f) => `${f.name} (${size(f.size)})`).join(", ")}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            onAllow(inputs);
          }}
        >
          Allow once
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function OutputImage({
  file,
  imageUrl,
}: {
  file: RunView["outputs"][number];
  imageUrl: (sha256: string) => Promise<string>;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    imageUrl(file.sha256).then(
      (u) => {
        if (live) setSrc(u);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [file.sha256, imageUrl]);
  return src ? (
    <img src={src} alt={file.path} className="max-w-full rounded border bg-white" />
  ) : null;
}

/** The latest attempt's output beside the code, with earlier attempts one pick away. */
export function RunOutput({ runs }: { runs: RunsProps }) {
  const [picked, setPicked] = useState<string | null>(null);
  const shown = runs.runs.find((r) => r.id === picked) ?? runs.runs[0];
  if (!shown && !runs.running) return null;
  return (
    <section className="mt-4 border-t pt-3" aria-label="Run output">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[11px] font-medium text-muted-foreground">Output</h3>
        {runs.runs.length > 1 && (
          <select
            aria-label="Attempt"
            className="h-7 rounded-md border border-input bg-background px-1.5 text-[11px]"
            value={shown?.id ?? ""}
            onChange={(e) => {
              setPicked(e.target.value);
            }}
          >
            {runs.runs.map((r) => (
              <option key={r.id} value={r.id}>
                v{r.version} · attempt {r.attempt} · {stateText(r)}
              </option>
            ))}
          </select>
        )}
        {runs.running && (
          <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={runs.onStop}>
            <Square className="size-3" />
            Stop
          </Button>
        )}
      </div>
      {shown && (
        <p className="mb-1 text-[11px] text-muted-foreground" role="status">
          Version {shown.version} · attempt {shown.attempt} · {stateText(shown)}
          {shown.elapsedMs !== null ? ` · ${(shown.elapsedMs / 1000).toFixed(1)} s` : ""}
          {shown.inputs.length > 0
            ? ` · inputs: ${shown.inputs.map((i) => i.name).join(", ")}`
            : ""}
          {` · SHA-256 ${shown.scriptSha256.slice(0, 12)}`}
        </p>
      )}
      <pre
        aria-label="Printed output"
        className="max-h-72 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap"
      >
        {(runs.running && (!picked || picked === runs.runs[0]?.id) ? runs.live : shown?.output) ||
          "(no output)"}
      </pre>
      {shown?.truncated && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Output went past 1 MB; the rest wasn't kept.
        </p>
      )}
      {shown && shown.outputs.length > 0 && (
        <div className="mt-2 flex flex-col gap-2" aria-label="Output files">
          {shown.outputs.map((f) =>
            /\.(png|jpe?g)$/i.test(f.path) && runs.imageUrl ? (
              <figure key={f.path}>
                <OutputImage file={f} imageUrl={runs.imageUrl} />
                <figcaption className="text-[11px] text-muted-foreground">
                  {f.path} ({size(f.bytes)})
                </figcaption>
              </figure>
            ) : (
              <p key={f.path} className="text-[11px] text-muted-foreground">
                {f.path} ({size(f.bytes)})
              </p>
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** The header button: run the version on screen, or why it can't run here. */
export function RunButton({ runs, onAsk }: { runs: RunsProps; onAsk: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-xs"
      aria-label="Run script"
      disabled={runs.running || runs.unavailable !== null}
      title={runs.unavailable ?? `Run version ${String(runs.version)} in the sandbox`}
      onClick={onAsk}
    >
      <Play className="size-3.5" />
      Run
    </Button>
  );
}

export function RunUnavailable({ text, onClose }: { text: string; onClose?: () => void }) {
  return (
    <p
      role="status"
      className="flex items-center gap-2 border-b px-4 py-1.5 text-[11px] text-muted-foreground"
    >
      <span className="flex-1">{text}</span>
      {onClose && (
        <button aria-label="Dismiss" onClick={onClose}>
          <X className="size-3" />
        </button>
      )}
    </p>
  );
}
