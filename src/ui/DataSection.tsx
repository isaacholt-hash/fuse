import {
  ArchiveRestore,
  Database,
  Download,
  FileCheck2,
  LoaderCircle,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  describeBackup,
  describeFileCheck,
  type BackupInfo,
  type BackupsApi,
} from "@/data/backups";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "./primitives";

/** What has to be typed before everything is deleted. */
export const DELETE_PHRASE = "delete everything";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Backups (PL-11): copies of the encrypted database, made before every update and on request.
 * A restore happens at the next start; the data it replaces is kept as a backup too.
 */
function Backups({ api }: { api: BackupsApi }) {
  const [list, setList] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let alive = true;
    api.list().then(
      (l) => {
        if (alive) setList(l);
      },
      (e: unknown) => {
        if (alive) setStatus(message(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const run = (task: () => Promise<string>) => {
    setBusy(true);
    setStatus(null);
    task().then(
      (line) => {
        setBusy(false);
        setStatus(line);
      },
      (e: unknown) => {
        setBusy(false);
        setStatus(message(e));
      },
    );
  };

  return (
    <div className="mt-5" aria-label="Backups" role="group">
      <h3 className="mb-1 text-xs font-medium">Backups</h3>
      <p className="mb-2 text-[11px] leading-5 text-muted-foreground">
        FUSE copies its encrypted database before every update. You can back up now, or go back to
        an earlier copy: FUSE restarts to restore it and keeps your current data as a backup, so a
        restore can be undone. Attached files aren&apos;t part of a backup; check them here.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            run(async () => {
              const made = await api.backupNow();
              setList(await api.list());
              return `Backed up: ${describeBackup(made)}.`;
            });
          }}
        >
          <Save className="size-3.5" />
          Back up now
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            run(async () => describeFileCheck(await api.checkFiles()));
          }}
        >
          <FileCheck2 className="size-3.5" />
          Check attached files
        </Button>
      </div>
      {status && (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {status}
        </p>
      )}
      {list.length > 0 ? (
        <ul className="mt-3 divide-y rounded-md border text-xs" aria-label="Saved backups">
          {list.map((b) => (
            <li key={b.name} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="text-muted-foreground">{describeBackup(b)}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Restore ${describeBackup(b)}`}
                onClick={() => {
                  setRestoring(b);
                }}
              >
                <ArchiveRestore className="size-3.5" />
                Restore…
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">No backups yet.</p>
      )}
      <Modal
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open && !applying) setRestoring(null);
        }}
        title="Restore this backup?"
        description={`FUSE restarts and opens the copy from ${restoring ? describeBackup(restoring) : ""}. Anything since then is kept in a backup of your current data, so you can switch back.`}
      >
        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={applying}
            onClick={() => {
              setRestoring(null);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={applying}
            onClick={() => {
              if (!restoring) return;
              setApplying(true);
              api.restore(restoring.name).catch((e: unknown) => {
                setApplying(false);
                setRestoring(null);
                setStatus(message(e));
              });
            }}
          >
            {applying ? "Restarting…" : "Restore and restart"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** Settings → Your data (SE-07, PL-11): export, back up and restore, or delete everything. */
export function DataSection({
  onExport,
  onDeleteAll,
  backups,
}: {
  /** Builds and saves the export; returns a line to show, or null if cancelled. */
  onExport: () => Promise<string | null>;
  /** Wipes all data (and the keys, when asked); the app then starts over empty. */
  onDeleteAll?: (removeKeys: boolean) => Promise<void>;
  backups?: BackupsApi;
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
      {backups && <Backups api={backups} />}
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
