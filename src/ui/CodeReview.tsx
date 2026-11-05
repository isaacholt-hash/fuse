import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "./primitives";
import { money } from "./format";
export interface ReviewChoice {
  task: string;
  kind: "changes" | "branch" | "github";
  folderId: string;
  baseRef: string;
  headRef: string;
  serverId: string;
  url: string;
  capMicroUsd: number;
}
const field =
  "w-full rounded-md border bg-background scheme-light dark:scheme-dark px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";
export function CodeReviewSetup({
  draft,
  folders,
  accounts,
  projectName,
  web,
  capMicroUsd,
  modelSummary,
  preview,
  reason,
  busy,
  error,
  onCancel,
  onStart,
}: {
  draft: string;
  folders: { id: string; name: string }[];
  accounts: { id: string; name: string }[];
  projectName: string | null;
  web: boolean;
  capMicroUsd: number;
  modelSummary: string;
  preview?: (task: string) => { summary: string; reason: string | null };
  reason: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onStart: (choice: ReviewChoice) => void;
}) {
  const [task, setTask] = useState(draft),
    [kind, setKind] = useState<ReviewChoice["kind"]>(folders.length ? "changes" : "github"),
    [folderId, setFolder] = useState(folders[0]?.id ?? ""),
    [baseRef, setBase] = useState(""),
    [headRef, setHead] = useState("HEAD"),
    [serverId, setServer] = useState(accounts[0]?.id ?? ""),
    [url, setUrl] = useState(""),
    [cap, setCap] = useState(String(capMicroUsd / 1_000_000));
  const calculated = preview?.(task);
  const activeReason = calculated ? calculated.reason : reason;
  const activeSummary = calculated ? calculated.summary : modelSummary;
  const amount = Math.round(Number(cap) * 1_000_000);
  const valid =
    !busy &&
    !activeReason &&
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    (kind === "github"
      ? Boolean(serverId && url.trim())
      : Boolean(folderId && (kind !== "branch" || (baseRef.trim() && headRef.trim()))));
  return (
    <Modal
      open
      wide
      title="Review code"
      description="Pin the changes and review findings before making any edits."
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            onStart({
              task: task.trim() || "Review the selected code changes for actionable defects.",
              kind,
              folderId,
              baseRef: baseRef.trim(),
              headRef: headRef.trim(),
              serverId,
              url: url.trim(),
              capMicroUsd: amount,
            });
        }}
      >
        <p className="text-xs text-muted-foreground">
          {projectName ?? "Outside a project"} · {web ? "HULK" : "This computer"} · Read only
        </p>
        <label className="block space-y-1 text-xs">
          <span>Review source</span>
          <select
            aria-label="Review source"
            className={field}
            value={kind}
            disabled={busy}
            onChange={(e) => {
              setKind(e.target.value as ReviewChoice["kind"]);
            }}
          >
            <option value="changes" disabled={!folders.length}>
              Local changes
            </option>
            <option value="branch" disabled={!folders.length}>
              Branch comparison
            </option>
            <option value="github">GitHub pull request</option>
          </select>
        </label>
        {kind !== "github" ? (
          <>
            <label className="block space-y-1 text-xs">
              <span>Linked folder</span>
              <select
                aria-label="Review folder"
                className={field}
                value={folderId}
                disabled={busy}
                onChange={(e) => {
                  setFolder(e.target.value);
                }}
              >
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            {kind === "branch" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs">
                  <span>Base branch or commit</span>
                  <input
                    aria-label="Review base"
                    className={field}
                    value={baseRef}
                    maxLength={256}
                    placeholder="main"
                    disabled={busy}
                    onChange={(e) => {
                      setBase(e.target.value);
                    }}
                  />
                </label>
                <label className="block space-y-1 text-xs">
                  <span>Head branch or commit</span>
                  <input
                    aria-label="Review head"
                    className={field}
                    value={headRef}
                    maxLength={256}
                    disabled={busy}
                    onChange={(e) => {
                      setHead(e.target.value);
                    }}
                  />
                </label>
              </div>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              {kind === "changes"
                ? "Captures staged, unstaged and untracked changes against HEAD. Ignored files stay excluded."
                : "Captures the selected head against its merge base with the base revision."}{" "}
              Files and revisions are pinned before any model request. At most twenty changed text
              files and 256 KiB are captured; omissions are listed in the result.
            </p>
          </>
        ) : (
          <>
            <label className="block space-y-1 text-xs">
              <span>Project GitHub account</span>
              <select
                aria-label="Review GitHub account"
                className={field}
                value={serverId}
                disabled={busy}
                onChange={(e) => {
                  setServer(e.target.value);
                }}
              >
                <option value="">Choose enabled account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            {!accounts.length && (
              <p className="text-xs leading-5 text-muted-foreground">
                Sign in under Settings → Code &amp; tools → Connections and enable GitHub for this
                project on {web ? "HULK" : "this computer"}. A linked folder is not required.
              </p>
            )}
            <label className="block space-y-1 text-xs">
              <span>Pull request URL</span>
              <input
                aria-label="Review pull request URL"
                type="url"
                className={field}
                value={url}
                placeholder="https://github.com/owner/repo/pull/123"
                maxLength={1000}
                disabled={busy}
                onChange={(e) => {
                  setUrl(e.target.value);
                }}
              />
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              Reads only repositories selected for that account. The reviewed head and merge-base
              revisions are pinned; unavailable source is listed as a limitation.
            </p>
          </>
        )}
        <label className="block space-y-1 text-xs">
          <span>Review focus (optional)</span>
          <textarea
            aria-label="Review focus"
            className={`${field} min-h-16 resize-y`}
            maxLength={10000}
            value={task}
            disabled={busy}
            placeholder="Specific behavior or risks to inspect"
            onChange={(e) => {
              setTask(e.target.value);
            }}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-xs">
            <span>Spending cap (USD)</span>
            <input
              aria-label="Review spending cap"
              type="number"
              min="0.000001"
              step="any"
              className={field}
              value={cap}
              disabled={busy}
              onChange={(e) => {
                setCap(e.target.value);
              }}
            />
          </label>
          <p className="self-end pb-2 text-xs leading-5 text-muted-foreground">
            {activeSummary}
            <br />
            Pauses before a request that cannot fit{" "}
            {Number.isSafeInteger(amount) && amount > 0 ? money(amount) : "the cap"}.
          </p>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Review creates a Code conversation. It does not edit files, run tests or commands, push,
          or post GitHub comments. Source snapshots stay on this execution owner; the reviewed
          report follows normal history settings.
        </p>
        {(error ?? activeReason) && (
          <p role="alert" className="text-xs text-destructive">
            {error ?? activeReason}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!valid}>
            {busy ? "Preparing review…" : "Start read-only review"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
