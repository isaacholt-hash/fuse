import { useEffect, useState } from "react";
import type { Catalog, ProviderId } from "@/catalog/catalog";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "@/routing/defaultPolicy";
import type { RoutingPolicy } from "@/routing/policy";
import { ChatApp } from "@/app/ChatApp";
import { tauriFilesApi, type FilesApi } from "@/files/api";
import { prepareImage as webviewPrepareImage, type PreparedImage } from "@/files/images";
import { tauriKeysApi, type KeysApi } from "@/keys/api";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import type { ProviderAdapter } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { markInterruptedMessages } from "@/storage/messages";
import type { SqlDb } from "@/storage/sql";
import { DbLockedError, openTauriDb, tauriRecoveryKey, unlockTauriDb } from "@/storage/tauriDb";
import { LockedScreen } from "@/ui/LockedScreen";
import { providerFetch } from "@/transport/tauriFetch";
import { defaultUpdateApi, type UpdateApi } from "@/update/api";
import { tauriWebApi, type WebApi } from "@/web/api";
import { tauriPreviewApi, type PreviewApi } from "@/artifacts/preview";
import { tauriExportApi, type ExportApi } from "@/artifacts/export";
import { tauriQuickCapture, type QuickCaptureApi } from "@/app/quickCapture";

// On desktop, every provider request goes through the Rust transport, which adds the key.
const desktopAdapters: Record<ProviderId, ProviderAdapter> = {
  anthropic: createAnthropicAdapter({ fetch: providerFetch("anthropic") }),
  openai: createOpenAIAdapter({ fetch: providerFetch("openai") }),
};
const desktopAdapterFor = (p: ProviderId) => desktopAdapters[p];
const desktopUpdates = defaultUpdateApi();

type Storage =
  | { kind: "opening" }
  | { kind: "ready"; db: SqlDb }
  | { kind: "locked" }
  | { kind: "error"; message: string };

interface Props {
  openDb?: () => Promise<SqlDb>;
  keysApi?: KeysApi;
  adapterFor?: (provider: ProviderId) => ProviderAdapter;
  catalog?: Catalog;
  policy?: RoutingPolicy;
  files?: FilesApi;
  prepareImage?: (file: File) => Promise<PreparedImage>;
  updates?: UpdateApi;
  /** Tries a recovery key on a locked database; true if it opened. */
  unlockDb?: (key: string) => Promise<boolean>;
  recoveryKey?: () => Promise<string>;
  /** Reads pasted links (FK-06). */
  web?: WebApi;
  preview?: PreviewApi;
  exporter?: ExportApi;
  quickCapture?: QuickCaptureApi;
}

export default function App({
  openDb = openTauriDb,
  keysApi = tauriKeysApi,
  adapterFor = desktopAdapterFor,
  catalog = defaultCatalog,
  policy = defaultPolicy,
  files = tauriFilesApi,
  prepareImage = webviewPrepareImage,
  updates = desktopUpdates,
  unlockDb = unlockTauriDb,
  recoveryKey = tauriRecoveryKey,
  web = tauriWebApi,
  preview = tauriPreviewApi,
  exporter = tauriExportApi,
  quickCapture = tauriQuickCapture,
}: Props) {
  const [storage, setStorage] = useState<Storage>({ kind: "opening" });
  // Bumped after a successful unlock, to open the database again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const alive = { current: true };
    void (async () => {
      try {
        const db = await openDb();
        // Answers that were streaming when the app last closed are marked as cut off.
        await markInterruptedMessages(db, DEFAULT_TENANT);
        if (alive.current) setStorage({ kind: "ready", db });
      } catch (e) {
        if (!alive.current) return;
        setStorage(
          e instanceof DbLockedError ? { kind: "locked" } : { kind: "error", message: String(e) },
        );
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [openDb, attempt]);

  if (storage.kind === "locked")
    return (
      <LockedScreen
        onUnlock={async (key) => {
          const ok = await unlockDb(key);
          if (ok) setAttempt((n) => n + 1);
          return ok;
        }}
      />
    );

  if (storage.kind !== "ready")
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-2 bg-background text-foreground">
        <h1 className="text-2xl font-semibold tracking-[0.12em]">FUSE</h1>
        <p className="font-mono text-xs text-muted-foreground" role="status">
          {storage.kind === "opening" ? "Opening storage…" : `Storage error: ${storage.message}`}
        </p>
      </main>
    );
  return (
    <ChatApp
      db={storage.db}
      tenant={DEFAULT_TENANT}
      catalog={catalog}
      policy={policy}
      keysApi={keysApi}
      adapterFor={adapterFor}
      files={files}
      web={web}
      preview={preview}
      exporter={exporter}
      quickCapture={quickCapture}
      prepareImage={prepareImage}
      updates={updates}
      recoveryKey={recoveryKey}
    />
  );
}
