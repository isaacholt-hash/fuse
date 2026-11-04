import { usePanelRequestGuard, usePanelLeave } from "./panelActivity";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "./primitives";
import type { SyncApi, SyncConflict, SyncPreview, SyncStatus } from "@/sync/api";
import { openExternal } from "./openExternal";

export function SyncSection({
  api,
  status,
  error,
  paired,
  address,
  onRefresh,
  onRevoke,
}: {
  api: SyncApi;
  status: SyncStatus | null;
  error: string | null;
  paired: boolean;
  address: string | null;
  onRefresh: () => Promise<void>;
  onRevoke?: (authId: string) => Promise<void>;
}) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.location.hash !== "#sync") return;
    const frame = requestAnimationFrame(() => {
      section.current?.scrollIntoView({ block: "start" });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [trust, setTrust] = useState(false);
  const [name, setName] = useState("This desktop");
  const [review, setReview] = useState<SyncConflict[] | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState("");
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);
  const requestGuard = usePanelRequestGuard();
  usePanelLeave(() => {
    setCode("");
    setShownCode(null);
    setSetup(false);
    setReview(null);
    setRecovering(false);
    setRevoking(null);
  });
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setSaid(null);
    try {
      await task();
      await onRefresh();
    } catch (e: unknown) {
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const host = status?.host ?? false;
  const dialogOpen = Boolean(setup || review || shownCode || recovering || revoking);
  const dialogError = said ? (
    <p role="alert" className="mb-3 text-xs text-destructive">
      {said}
    </p>
  ) : null;
  return (
    <section ref={section} className="mt-8 border-t pt-6" aria-label="Sync" id="sync">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <RefreshCw className="size-4 text-muted-foreground" />
        Sync
      </h2>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
        Opt in to encrypted sync with HULK. HULK is trusted and can read synced content for its web
        app and runner. Browsers use HULK’s database. Pairing alone never uploads this desktop’s
        history.
      </p>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
        Incognito content, local-only projects and records kept on this device stay here.
        Credentials, repositories, folder access and machine permissions stay on each machine.
        Opening history grants no new access or run execution.
      </p>
      {!dialogOpen && (said || error || status?.error) && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {said ?? error ?? status?.error}
        </p>
      )}
      {!status ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {error
            ? "Sync status is unavailable. Retry after checking the connection and app versions."
            : "Checking sync…"}
        </p>
      ) : (
        <>
          {status.rotationPending && host && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void run(() => api.finishRotation());
              }}
            >
              Finish device revocation
            </Button>
          )}
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt>Status</dt>
            <dd>{!status.enabled ? "Off" : status.paused ? "Paused" : "On"}</dd>
            <dt>Last successful sync</dt>
            <dd>
              {status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : "Never"}
            </dd>
            <dt>Pending changes</dt>
            <dd>{status.pending}</dd>
          </dl>
          {status.fileBytes > 0 && (
            <div className="mt-3">
              <label className="text-xs" htmlFor="sync-file-progress">
                Files: {status.fileBytesDone.toLocaleString()} / {status.fileBytes.toLocaleString()}{" "}
                bytes
              </label>
              <progress
                id="sync-file-progress"
                className="mt-1 block w-full"
                max={status.fileBytes}
                value={status.fileBytesDone}
              />
            </div>
          )}
          {status.blocked.map((message) => (
            <p key={message} role="status" className="mt-2 text-xs text-muted-foreground">
              {message}
            </p>
          ))}
          <div className="mt-3 flex flex-wrap gap-2">
            {!status.enabled ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || (!host && !paired)}
                onClick={() => {
                  setSetup(true);
                  setTrust(false);
                  setPreview(null);
                  void run(async () => {
                    setPreview(await api.preview());
                  });
                }}
              >
                Preview &amp; enable sync
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || status.rotationPending}
                  onClick={() => {
                    void run(() => api.pause(!status.paused));
                  }}
                >
                  {status.paused ? "Resume" : "Pause"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || status.paused}
                  onClick={() => {
                    void run(() => api.now());
                  }}
                >
                  Sync now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void run(() => api.disable());
                  }}
                >
                  Disable sync
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void run(onRefresh);
              }}
            >
              Refresh status
            </Button>
            {status.conflicts > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    setReview(await api.conflicts());
                  });
                }}
              >
                Review {status.conflicts} {status.conflicts === 1 ? "conflict" : "conflicts"}
              </Button>
            )}
          </div>
          {!host && !paired && (
            <p className="mt-2 text-xs text-muted-foreground">
              Pair this desktop in Settings → HULK first, then explicitly enable sync here.
            </p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Disabling sync stops transfers and preserves local data. It does not delete everywhere.
            Pending changes wait for explicit re-enrollment.
          </p>
          {status.epoch > 0 && (
            <>
              <h3 data-settings-control="sync-devices" className="mt-5 text-xs font-medium">
                Devices
              </h3>
              <ul className="mt-2 space-y-2">
                {status.devices.map((device) => (
                  <li className="flex flex-wrap items-center gap-2 text-xs" key={device.id}>
                    <span>
                      {device.name}
                      {device.id === status.deviceId ? " · this installation" : ""}
                      {device.revokedAt ? " · revoked" : ""}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {device.id.slice(0, 12)}
                    </span>
                    {host && onRevoke && device.authId && !device.revokedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setRevoking({ id: device.authId ?? "", name: device.name });
                        }}
                      >
                        Revoke {device.name}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <h3 data-settings-control="sync-recovery" className="mt-5 text-xs font-medium">
                Recovery
              </h3>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                Keep the separate sync recovery code safely away from this computer. Recovery also
                requires signing in to HULK. Without surviving keys or this code, encrypted sync
                data cannot be recovered. The database recovery key is separate.
              </p>
              {host ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        const current = requestGuard();
                        const recovery = await api.recoveryCode();
                        if (current()) setShownCode(recovery);
                      });
                    }}
                  >
                    Show sync recovery code
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setCode("");
                      setRecovering(true);
                    }}
                  >
                    Recover sync
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Manage recovery and device revocation in HULK’s signed-in Settings.
                </p>
              )}
            </>
          )}
          {!host && address && (
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => {
                const target = new URL(address);
                target.hash = "sync";
                openExternal(target.toString());
              }}
            >
              Open HULK Settings
            </Button>
          )}
          {host && status.epoch === 0 && (
            <Button
              className="mt-2"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setCode("");
                setRecovering(true);
              }}
            >
              Recover an existing sync workspace
            </Button>
          )}
        </>
      )}
      {setup && (
        <Modal
          title="Enable encrypted sync"
          description="Merge this installation’s eligible history with HULK, preserving record IDs."
          open
          onOpenChange={() => {
            if (!busy) setSetup(false);
          }}
        >
          {dialogError}
          {preview ? (
            <>
              <ul className="max-h-48 space-y-1 overflow-auto text-xs">
                {preview.counts
                  .filter((c) => c.records > 0)
                  .map((c) => (
                    <li key={c.table}>
                      {c.table.replaceAll("_", " ")}: {c.records.toLocaleString()}
                    </li>
                  ))}
              </ul>
              <p className="mt-2 text-xs">
                Eligible file bytes: {preview.fileBytes.toLocaleString()}
              </p>
            </>
          ) : (
            <p className="text-xs">Preparing eligible-content preview…</p>
          )}
          {!host && (
            <label className="mt-3 block text-xs">
              Device name
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                maxLength={80}
              />
            </label>
          )}
          <label className="mt-3 flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={trust}
              onChange={(e) => {
                setTrust(e.target.checked);
              }}
            />
            I trust HULK to read the eligible synced content shown above.
          </label>
          <Button
            className="mt-4"
            size="sm"
            disabled={busy || !preview || !trust || (!host && !name.trim())}
            onClick={() => {
              void run(async () => {
                await api.enable(host, name.trim());
                setSetup(false);
              });
            }}
          >
            Enable sync and merge histories
          </Button>
        </Modal>
      )}
      {review && (
        <Modal
          title="Review memory conflicts"
          description="Both versions are withheld from model context until you choose. Current privacy and scope are preserved."
          open
          onOpenChange={() => {
            if (!busy) setReview(null);
          }}
        >
          {dialogError}
          <div className="max-h-[60vh] space-y-5 overflow-auto">
            {review.map((conflict) => (
              <div key={conflict.id} className="space-y-3">
                {conflict.versions.map((version) => (
                  <article className="rounded-lg border p-3" key={version.eventId}>
                    <p className="whitespace-pre-wrap break-words text-xs">{version.text}</p>
                    {version.rationale && (
                      <p className="mt-2 whitespace-pre-wrap text-xs">{version.rationale}</p>
                    )}
                    {version.alternatives && (
                      <p className="mt-2 whitespace-pre-wrap text-xs">
                        Alternatives: {version.alternatives}
                      </p>
                    )}
                    <p className="mt-2 break-all text-[10px] text-muted-foreground">
                      {version.kind} · {version.deviceId} ·{" "}
                      {new Date(version.createdAt).toLocaleString()} ·{" "}
                      {version.extractionMethod ?? "manual"}
                      <br />
                      Source chat: {version.sourceThreadId ?? "unavailable"} · message:{" "}
                      {version.sourceMessageId ?? "unavailable"}
                      <br />
                      Artifact: {version.sourceArtifactId ?? "unavailable"} ·{" "}
                      {version.extractionModel ?? "manual source"} ·{" "}
                      {version.authority ?? "unknown authority"} · confidence{" "}
                      {version.confidence ?? "unknown"}
                      <br />
                      Revision: {version.eventId}
                    </p>
                    <Button
                      className="mt-2"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        void run(async () => {
                          await api.resolve(conflict.recordId, version.eventId);
                          setReview(await api.conflicts());
                        });
                      }}
                    >
                      Use version from {version.deviceId}
                    </Button>
                  </article>
                ))}
              </div>
            ))}
            {review.length === 0 && <p className="text-xs">All conflicts are resolved.</p>}
          </div>
        </Modal>
      )}
      {shownCode && (
        <Modal
          title="Sync recovery code"
          description="Store this code safely. It is separate from the database recovery key and never enrolls a device by itself."
          open
          onOpenChange={() => {
            setShownCode(null);
          }}
        >
          {dialogError}
          <p className="select-all break-all font-mono text-xs">{shownCode}</p>
          <Button
            className="mt-3"
            size="sm"
            onClick={() => {
              setShownCode(null);
            }}
          >
            Done
          </Button>
        </Modal>
      )}
      {recovering && (
        <Modal
          title="Recover encrypted sync"
          description="You must be signed in to HULK. Pending local changes are preserved and sync pauses during recovery."
          open
          onOpenChange={() => {
            if (!busy) {
              setRecovering(false);
              setCode("");
            }
          }}
        >
          {dialogError}
          <label className="text-xs">
            Sync recovery code
            <Input
              type="password"
              value={code}
              autoComplete="off"
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
          </label>
          <Button
            className="mt-3"
            size="sm"
            disabled={busy || !code.trim()}
            onClick={() => {
              void run(async () => {
                await api.recover(code);
                setCode("");
                setRecovering(false);
              });
            }}
          >
            Recover sync
          </Button>
        </Modal>
      )}
      {revoking && (
        <Modal
          title={`Revoke ${revoking.name}?`}
          description="Immediately block this device’s token and future sync, and rotate encryption and recovery material. This cannot erase copies already downloaded. Save the new recovery code afterward."
          open
          onOpenChange={() => {
            if (!busy) setRevoking(null);
          }}
        >
          {dialogError}
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              void run(async () => {
                await onRevoke?.(revoking.id);
                setRevoking(null);
              });
            }}
          >
            Revoke device and rotate keys
          </Button>
        </Modal>
      )}
    </section>
  );
}
