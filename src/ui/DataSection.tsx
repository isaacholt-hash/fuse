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
import { Greyed, Modal } from "./primitives";

/** What has to be typed before everything is deleted. */
export const DELETE_PHRASE = "delete everything";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Backups (PL-11): copies of the encrypted database, made before every update and on request.
 * A restore happens at the next start; the data it replaces is kept as a backup too.
 */
function Backups({ api, restoreReason }: { api: BackupsApi; restoreReason?: string }) {
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
                disabled={Boolean(restoreReason)}
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
      {restoreReason && <Greyed>{restoreReason}</Greyed>}
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

/** What an export holds, for the preview before a restore (PL-12). */
export interface RestorePreview {
  /** e.g. "An export of everything from 29 Oct 2026." */
  title: string;
  /** Projects in it, when it's a whole export: you can restore just one. */
  projects: { id: string; name: string }[];
  /** One line per kind of record, for a project or everything (null). */
  counts: (
    projectId: string | null,
  ) => Promise<{ label: string; rows: number; existing: number }[]>;
}

export interface RestoreApi {
  /** Reads and checks the file; nothing is written. */
  read: (file: File) => Promise<RestorePreview>;
  /** Writes it in (everything, or one project); returns a line to show. */
  apply: (projectId: string | null) => Promise<string>;
}

/** Restore from a FUSE export (PL-12): a preview of what's new first, then a yes. */
function Restore({ api }: { api: RestoreApi }) {
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ label: string; rows: number; existing: number }[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!preview) return;
    let alive = true;
    preview.counts(projectId).then(
      (c) => {
        if (alive) setCounts(c);
      },
      (e: unknown) => {
        if (alive) setStatus(message(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [preview, projectId]);
  const adding = counts.reduce((sum, c) => sum + c.rows - c.existing, 0);
  return (
    <div className="mt-5" role="group" aria-label="Restore from an export">
      <h3 className="mb-1 text-xs font-medium">Restore from an export</h3>
      <p className="mb-2 text-[11px] leading-5 text-muted-foreground">
        Bring back a FUSE export, everything or one project. Records already here are kept as they
        are; only missing ones are added.
      </p>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1 text-xs hover:bg-accent">
        <ArchiveRestore className="size-3.5" />
        Choose an export…
        <input
          type="file"
          accept=".zip,application/zip"
          aria-label="Export file"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setStatus(null);
            setProjectId(null);
            setCounts([]);
            api.read(file).then(setPreview, (err: unknown) => {
              setStatus(message(err));
            });
          }}
        />
      </label>
      {status && (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {status}
        </p>
      )}
      <Modal
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPreview(null);
        }}
        title="Restore this export?"
        description={preview?.title ?? ""}
      >
        {preview && preview.projects.length > 0 && (
          <select
            aria-label="What to restore"
            className="mb-3 h-8 w-full rounded-lg border border-input bg-background px-2 text-xs"
            value={projectId ?? ""}
            onChange={(e) => {
              setProjectId(e.target.value || null);
            }}
          >
            <option value="">Everything in it</option>
            {preview.projects.map((p) => (
              <option key={p.id} value={p.id}>
                Only the project {p.name}
              </option>
            ))}
          </select>
        )}
        <ul className="mb-3 space-y-0.5 text-xs" aria-label="What it holds">
          {counts.map((c) => (
            <li key={c.label} className="flex justify-between">
              <span>{c.label}</span>
              <span className="font-mono text-muted-foreground">
                {c.rows - c.existing} new{c.existing ? ` · ${String(c.existing)} already here` : ""}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setPreview(null);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || adding === 0}
            onClick={() => {
              setBusy(true);
              api.apply(projectId).then(
                (line) => {
                  setBusy(false);
                  setPreview(null);
                  setStatus(line);
                },
                (e: unknown) => {
                  setBusy(false);
                  setPreview(null);
                  setStatus(message(e));
                },
              );
            }}
          >
            {busy ? "Restoring…" : adding === 0 ? "Nothing new" : "Restore"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** Settings → Your data (SE-07, PL-11, PL-12): export, back up and restore, or delete everything. */
export function DataSection({
  onExport,
  onDeleteAll,
  backups,
  restore,
  backupRestoreReason,
}: {
  restore?: RestoreApi;
  /** PL-02: why restoring a backup is greyed here (the web app on HULK). */
  backupRestoreReason?: string;
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
      {restore && <Restore api={restore} />}
      {backups && (
        <Backups
          api={backups}
          {...(backupRestoreReason ? { restoreReason: backupRestoreReason } : {})}
        />
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
