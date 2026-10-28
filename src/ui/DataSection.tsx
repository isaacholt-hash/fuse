import { Database, Download, LoaderCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "./primitives";

/** What has to be typed before everything is deleted. */
export const DELETE_PHRASE = "delete everything";

/** Settings → Your data (SE-07): export everything, or delete everything. */
export function DataSection({
  onExport,
  onDeleteAll,
}: {
  /** Builds and saves the export; returns a line to show, or null if cancelled. */
  onExport: () => Promise<string | null>;
  /** Wipes all data (and the keys, when asked); the app then starts over empty. */
  onDeleteAll?: (removeKeys: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [removeKeys, setRemoveKeys] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
      {onDeleteAll && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 text-destructive"
            onClick={() => {
              setTyped("");
              setRemoveKeys(false);
              setConfirming(true);
            }}
          >
            <Trash2 className="size-3.5" />
            Delete everything…
          </Button>
          <Modal
            open={confirming}
            onOpenChange={(open) => {
              if (!deleting) setConfirming(open);
            }}
            title="Delete everything?"
            description="Every chat, memory, project, artifact, budget, usage record and attached file on this computer is deleted for good. Export first if you might want any of it."
          >
            <label className="mb-1.5 block text-xs">
              Type <span className="font-mono font-medium">{DELETE_PHRASE}</span> to confirm
            </label>
            <Input
              aria-label="Confirmation"
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
              }}
            />
            <label className="mt-3 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={removeKeys}
                onChange={(e) => {
                  setRemoveKeys(e.target.checked);
                }}
              />
              Also remove my API keys from this computer
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={deleting}
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={typed.trim().toLowerCase() !== DELETE_PHRASE || deleting}
                onClick={() => {
                  setDeleting(true);
                  onDeleteAll(removeKeys).catch((e: unknown) => {
                    setDeleting(false);
                    setStatus(e instanceof Error ? e.message : String(e));
                  });
                }}
              >
                {deleting ? "Deleting…" : "Delete everything"}
              </Button>
            </div>
          </Modal>
        </>
      )}
    </section>
  );
}
