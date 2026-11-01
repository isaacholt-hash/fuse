import { tauriLocalApi, type LocalApi } from "@/local/api";
import { tauriPythonApi, type PythonApi } from "@/python/runtime";
import { tauriMcpApi, type McpApi } from "@/mcp/api";
import { createLocalAdapter } from "@/providers/local/adapter";
import { tauriLocalBackend } from "@/providers/local/tauri";
import { localModels } from "@/local/models";
import { useEffect, useMemo, useState } from "react";
import type { Catalog, ProviderId } from "@/catalog/catalog";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "@/routing/defaultPolicy";
import type { RoutingPolicy } from "@/routing/policy";
import { ChatApp } from "@/app/ChatApp";
import { tauriFilesApi, type FilesApi } from "@/files/api";
import { prepareImage as webviewPrepareImage, type PreparedImage } from "@/files/images";
import { tauriKeysApi, type KeysApi } from "@/keys/api";
import { httpAuthApi, MIN_PASSPHRASE, type AuthApi } from "@/platform/auth";
import { onSignedOut } from "@/platform/http";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import type { ProviderAdapter } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { markInterruptedMessages } from "@/storage/messages";
import { markInterruptedRuns } from "@/storage/runs";
import type { SqlDb } from "@/storage/sql";
import { DbLockedError, openTauriDb, tauriRecoveryKey, unlockTauriDb } from "@/storage/tauriDb";
import { LockedScreen } from "@/ui/LockedScreen";
import { ServerSection } from "@/ui/ServerSection";
import { SignInScreen } from "@/ui/SignIn";
import { providerFetch } from "@/transport/tauriFetch";
import { defaultUpdateApi, serverUpdates, type UpdateApi } from "@/update/api";
import { tauriWebApi, type WebApi } from "@/web/api";
import { tauriPreviewApi, type PreviewApi } from "@/artifacts/preview";
import { browserExportApi, tauriExportApi, type ExportApi } from "@/artifacts/export";
import { tauriRepo, type RepoApi } from "@/repo/api";
import { tauriExec, type ExecApi } from "@/repo/exec";
import { tauriGit, type GitApi } from "@/repo/git";
import { tauriBackupsApi, type BackupsApi } from "@/data/backups";
import { tauriQuickCapture, type QuickCaptureApi } from "@/app/quickCapture";
import { tauriZoom, type ZoomApi } from "@/app/appearance";
import { tauriHello, type HelloApi } from "@/security/hello";

// On desktop, every provider request goes through the Rust transport, which adds the key.
// (In the web app the same transport runs in fuse-server, with the key from systemd-creds.)
const desktopAdapters: Record<ProviderId, ProviderAdapter> = {
  anthropic: createAnthropicAdapter({ fetch: providerFetch("anthropic") }),
  openai: createOpenAIAdapter({ fetch: providerFetch("openai") }),
  // LL-02: the model file on this computer, run by FUSE's own worker; never a network call.
  local: createLocalAdapter({
    backend: tauriLocalBackend,
    fileFor: (id) => localModels.profiles.find((p) => p.id === id)?.file ?? null,
  }),
};
const desktopAdapterFor = (p: ProviderId) => desktopAdapters[p];
const desktopUpdates = defaultUpdateApi();

// The web app's commands are the server's (api::WEB_COMMANDS): no Windows sandbox switch, and no
// MCP sign-in (OAuth) yet, so those parts of the desktop's apis are left out.
const webExec: ExecApi = { ...tauriExec, windowsSandbox: undefined };
const webMcp: McpApi = { ...tauriMcpApi, signIn: undefined };

type Storage =
  | { kind: "opening" }
  | { kind: "ready"; db: SqlDb }
  | { kind: "locked" }
  | { kind: "error"; message: string };

/** The web app's sign-in (M10 step 5); the desktop is always "in". */
type Gate =
  | { kind: "checking" }
  | { kind: "setUp" }
  | { kind: "signIn" }
  | { kind: "in"; version: string }
  | { kind: "error"; message: string };

interface Props {
  /**
   * M10 step 5: the web app on HULK, over HTTP to fuse-server (`!isDesktop()`, set in main.tsx).
   * It signs in first, and greys what only the desktop can do (PL-02).
   */
  webApp?: boolean;
  /** The web app's sign-in and devices (src/platform/auth.ts); tests pass a fake. */
  auth?: AuthApi;
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
  /** The coding agent's linked repository (CA-01). */
  repo?: RepoApi;
  /** Commands in that repository (CA-03). */
  exec?: ExecApi;
  /** git and gh there (CA-05). */
  git?: GitApi;
  backups?: BackupsApi;
  /** The local model: hardware, install, run (M7). */
  local?: LocalApi;
  /** The Python runtime for data work (M9 step 5). */
  python?: PythonApi;
  /** MCP servers' keychain values (M9 step 8). */
  mcp?: McpApi;
  quickCapture?: QuickCaptureApi;
  /** Sets the webview zoom for the text size (PL-10). */
  zoom?: ZoomApi;
  /** Windows Hello for the app lock (SE-03). */
  hello?: HelloApi;
  /** Starts the app over after delete-all (tests pass a spy). */
  onRestart?: () => void;
}

export default function App({
  webApp = false,
  auth = httpAuthApi,
  openDb = openTauriDb,
  keysApi = tauriKeysApi,
  adapterFor = desktopAdapterFor,
  catalog = defaultCatalog,
  policy = defaultPolicy,
  files = tauriFilesApi,
  prepareImage = webviewPrepareImage,
  updates,
  unlockDb = unlockTauriDb,
  recoveryKey = tauriRecoveryKey,
  web = tauriWebApi,
  preview = tauriPreviewApi,
  exporter = webApp ? browserExportApi : tauriExportApi,
  repo = tauriRepo,
  exec = webApp ? webExec : tauriExec,
  git = tauriGit,
  backups = tauriBackupsApi,
  // What only the desktop has is left out of the web app, and greyed there instead.
  local = webApp ? undefined : tauriLocalApi,
  python = tauriPythonApi,
  mcp = webApp ? webMcp : tauriMcpApi,
  quickCapture = webApp ? undefined : tauriQuickCapture,
  zoom = webApp ? undefined : tauriZoom,
  hello = webApp ? undefined : tauriHello,
  onRestart,
}: Props) {
  const [storage, setStorage] = useState<Storage>({ kind: "opening" });
  // Bumped after a successful unlock, to open the database again.
  const [attempt, setAttempt] = useState(0);
  const [gate, setGate] = useState<Gate>(
    webApp ? { kind: "checking" } : { kind: "in", version: "" },
  );
  // Bumped after setting up or signing in, to ask the server again.
  const [asked, setAsked] = useState(0);
  const signedIn = gate.kind === "in";

  useEffect(() => {
    if (!webApp) return;
    let alive = true;
    auth.state().then(
      (s) => {
        if (!alive) return;
        setGate(
          s.signedIn
            ? { kind: "in", version: s.version }
            : s.setUp
              ? { kind: "signIn" }
              : { kind: "setUp" },
        );
      },
      (e: unknown) => {
        if (alive) setGate({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [webApp, auth, asked]);

  // A command answered "signed_out" (the session ran out, or was signed out elsewhere).
  useEffect(
    () =>
      webApp
        ? onSignedOut(() => {
            setGate({ kind: "signIn" });
          })
        : undefined,
    [webApp],
  );

  useEffect(() => {
    if (!signedIn) return;
    const alive = { current: true };
    void (async () => {
      try {
        const db = await openDb();
        // Answers that were streaming when the app last closed are marked as cut off. Not in
        // the web app: there a run may still be going in the server's runner (M10 step 6),
        // which marks interrupted work itself, on the server.
        if (!webApp) {
          await markInterruptedMessages(db, DEFAULT_TENANT);
          await markInterruptedRuns(db, DEFAULT_TENANT);
        }
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
  }, [openDb, attempt, signedIn, webApp]);

  const version = gate.kind === "in" ? gate.version : "";
  const appUpdates = useMemo(
    () => updates ?? (webApp ? serverUpdates(version) : desktopUpdates),
    [updates, webApp, version],
  );

  if (gate.kind === "setUp" || gate.kind === "signIn") {
    const mode = gate.kind;
    return (
      <SignInScreen
        key={mode}
        mode={mode}
        minLength={MIN_PASSPHRASE}
        onSubmit={async (passphrase) => {
          try {
            await (mode === "setUp" ? auth.setUp(passphrase) : auth.signIn(passphrase));
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          setGate({ kind: "checking" });
          setAsked((n) => n + 1);
          return null;
        }}
      />
    );
  }

  if (signedIn && storage.kind === "locked")
    return (
      <LockedScreen
        onUnlock={async (key) => {
          const ok = await unlockDb(key);
          if (ok) setAttempt((n) => n + 1);
          return ok;
        }}
      />
    );

  if (!signedIn || storage.kind !== "ready")
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-2 bg-background text-foreground">
        <h1 className="text-2xl font-semibold tracking-[0.12em]">FUSE</h1>
        <p className="font-mono text-xs text-muted-foreground" role="status">
          {gate.kind === "checking"
            ? "Connecting to HULK…"
            : gate.kind === "error"
              ? `Couldn't reach FUSE on HULK: ${gate.message}`
              : storage.kind === "error"
                ? `Storage error: ${storage.message}`
                : "Opening storage…"}
        </p>
      </main>
    );
  return (
    <ChatApp
      webApp={webApp}
      {...(webApp
        ? {
            server: (
              <ServerSection
                version={version}
                auth={auth}
                onSignedOut={() => {
                  setGate({ kind: "signIn" });
                }}
              />
            ),
          }
        : {})}
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
      repoApi={repo}
      execApi={exec}
      gitApi={git}
      backups={backups}
      localApi={local}
      pythonApi={python}
      mcpApi={mcp}
      quickCapture={quickCapture}
      zoom={zoom}
      hello={hello}
      {...(onRestart ? { onRestart } : {})}
      prepareImage={prepareImage}
      updates={appUpdates}
      recoveryKey={recoveryKey}
    />
  );
}
