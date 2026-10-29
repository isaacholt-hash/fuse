import { money, number } from "./format";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  KeyRound,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Moon,
  ShieldCheck,
  Sun,
  Terminal,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProviderId } from "@/catalog/catalog";
import { openExternal } from "./openExternal";
import { Modal } from "./primitives";
import type { KeyView, Motion, RequestRow, TextSize, Theme } from "./types";

function KeyResult({ state }: { state: KeyView }) {
  if (state.busy === "testing" || state.busy === "saving")
    return (
      <span role="status" className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        {state.busy === "saving" ? "Saving and testing…" : "Testing…"}
      </span>
    );
  if (!state.result) return null;
  const { tone, text } = state.result;
  return (
    <span
      role="status"
      className={`flex items-center gap-1.5 text-[10px] ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
    >
      {tone === "ok" ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
      {text}
    </span>
  );
}

export function KeyCard({
  state,
  onSave,
  onTest,
  onDelete,
}: {
  state: KeyView;
  /** The key goes straight to the keychain; it is never kept in component state. */
  onSave: (key: string) => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const [hasInput, setHasInput] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = state.busy !== null;
  const showForm = !state.saved || replacing;
  return (
    <section
      className="rounded-xl border bg-card p-5 text-card-foreground"
      aria-label={`${state.name} key`}
    >
      <div className="mb-5 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg border bg-background font-serif text-lg">
          {state.provider === "openai" ? "◎" : "✳"}
        </span>
        <div>
          <h3 className="text-sm font-semibold">{state.name}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {state.provider === "openai" ? "GPT models" : "Claude models"}
          </p>
        </div>
        <a
          className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground"
          href={state.consoleUrl}
          onClick={(e) => {
            e.preventDefault();
            openExternal(state.consoleUrl);
          }}
        >
          Provider console
          <ExternalLink className="size-3" />
        </a>
      </div>
      {state.busy === "loading" ? (
        <p className="text-xs text-muted-foreground">Checking the keychain…</p>
      ) : (
        <>
          {state.saved && (
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5">
              <span className="font-mono text-xs">{state.masked}</span>
              {!showForm && <KeyResult state={state} />}
            </div>
          )}
          {state.saved && !replacing && (
            <div className="mt-3 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onTest} disabled={busy}>
                Test
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setReplacing(true);
                }}
              >
                Replace
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-muted-foreground hover:text-destructive"
                aria-label={`Delete ${state.name} key`}
                disabled={busy}
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )}
          {showForm && (
            <form
              className={state.saved ? "mt-3" : ""}
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const key = new FormData(form).get("key");
                form.reset();
                setHasInput(false);
                if (typeof key === "string" && key.trim()) {
                  onSave(key.trim());
                  setReplacing(false);
                }
              }}
            >
              <label
                className="mb-2 block text-xs text-muted-foreground"
                htmlFor={`key-${state.provider}`}
              >
                {replacing ? "New API key" : "API key"}
              </label>
              <div className="flex gap-2">
                <Input
                  id={`key-${state.provider}`}
                  name="key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your key"
                  disabled={busy}
                  onChange={(e) => {
                    setHasInput(e.target.value.length > 0);
                  }}
                />
                <Button type="submit" disabled={!hasInput || busy}>
                  Save & test
                </Button>
                {replacing && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setReplacing(false);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              <div className="mt-2 flex min-h-4 items-center justify-between gap-2">
                {!state.saved && !state.result && state.busy === null && (
                  <p className="text-[10px] text-muted-foreground">
                    No key yet. Add one to use {state.name} models.
                  </p>
                )}
                <KeyResult state={state} />
              </div>
            </form>
          )}
        </>
      )}
      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${state.name} key?`}
        description="It's removed from your OS keychain. You'll need to add a key again to use these models."
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setConfirmDelete(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmDelete(false);
              onDelete();
            }}
          >
            Delete key
          </Button>
        </div>
      </Modal>
    </section>
  );
}
export function SettingsView({
  keys,
  version,
  onRecoveryKey,
  instructions,
  memory,
  routing,
  budgets,
  prices,
  models,
  prompts,
  modelDefaults,
  quickCapture,
  data,
  appLock,
  importer,
  theme,
  onTheme,
  textSize,
  onTextSize,
  motion,
  onMotion,
  onBack,
  onSaveKey,
  onTestKey,
  onDeleteKey,
  onShowLog,
}: {
  keys: KeyView[];
  /** The installed app version; null while it loads. */
  version: string | null;
  /** The database recovery key, shown only when asked for. */
  onRecoveryKey: () => Promise<string>;
  /** Settings → Custom instructions; rendered once loaded. */
  instructions: ReactNode;
  /** Settings → Memory; rendered once loaded. */
  memory?: ReactNode;
  /** Settings → Routing test set; rendered once loaded. */
  routing?: ReactNode;
  /** Settings → Budgets (CO-03). */
  budgets?: ReactNode;
  /** Settings → Prices (MM-04). */
  prices?: ReactNode;
  /** Settings → Models (MM-03, MM-08). */
  models?: ReactNode;
  /** Settings → Prompt library (CH-12). */
  prompts?: ReactNode;
  /** Settings → Model defaults (MM-07). */
  modelDefaults?: ReactNode;
  /** Settings → Quick capture (CH-08). */
  quickCapture?: ReactNode;
  /** Settings → Your data (SE-07). */
  data?: ReactNode;
  /** Settings → App lock (SE-03). */
  appLock?: ReactNode;
  /** Settings → Import (PL-08). */
  importer?: ReactNode;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  /** PL-10 */
  textSize: TextSize;
  onTextSize: (size: TextSize) => void;
  motion: Motion;
  onMotion: (motion: Motion) => void;
  onBack: () => void;
  onSaveKey: (provider: ProviderId, key: string) => void;
  onTestKey: (provider: ProviderId) => void;
  onDeleteKey: (provider: ProviderId) => void;
  onShowLog: () => void;
}) {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <header className="flex h-[66px] items-center border-b px-6">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          Back to conversation
        </Button>
      </header>
      <div className="mx-auto max-w-[660px] px-8 py-9">
        <p className="mb-2 text-[10px] font-medium tracking-[0.15em] text-muted-foreground uppercase">
          Make yourself at home
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-xs text-muted-foreground">
          Your models, your keys, your workspace.
        </p>
        <div className="mt-8 mb-4 flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">API keys</h2>
        </div>
        <div className="space-y-3">
          {keys.map((key) => (
            <KeyCard
              key={key.provider}
              state={key}
              onSave={(value) => {
                onSaveKey(key.provider, value);
              }}
              onTest={() => {
                onTestKey(key.provider);
              }}
              onDelete={() => {
                onDeleteKey(key.provider);
              }}
            />
          ))}
        </div>
        <div className="mt-4 flex items-start gap-2.5 text-[11px] leading-5 text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>
            Keys are stored in your OS keychain and never leave this device except to call the
            provider.
          </p>
        </div>
        {instructions}
        {memory}
        {budgets}
        {prompts}
        {modelDefaults}
        {models}
        {prices}
        {appLock}
        {quickCapture}
        {importer}
        {data}
        {routing}
        <RecoveryKeySection load={onRecoveryKey} />
        <section className="mt-8 border-t pt-6">
          <h2 className="text-sm font-medium">Appearance</h2>
          <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Theme">
            {(
              [
                { value: "light", label: "Light", icon: Sun },
                { value: "dark", label: "Dark", icon: Moon },
                { value: "system", label: "System", icon: Laptop },
              ] as const
            ).map((item) => (
              <Button
                key={item.value}
                variant="outline"
                className={`h-10 gap-2 text-xs ${theme === item.value ? "border-foreground bg-muted" : "text-muted-foreground"}`}
                aria-pressed={theme === item.value}
                onClick={() => {
                  onTheme(item.value);
                }}
              >
                <item.icon className="size-3.5" />
                {item.label}
                {theme === item.value && <Check className="ml-auto size-3" />}
              </Button>
            ))}
          </div>
          <Choice
            label="Text size"
            value={textSize}
            options={[
              { value: "small", label: "Small" },
              { value: "normal", label: "Normal" },
              { value: "large", label: "Large" },
            ]}
            onChange={onTextSize}
          />
          <Choice
            label="Motion"
            value={motion}
            options={[
              { value: "system", label: "Like the system" },
              { value: "reduce", label: "Reduced" },
              { value: "full", label: "Full" },
            ]}
            onChange={onMotion}
          />
        </section>
        <button
          className="mt-7 flex w-full items-center gap-3 border-t pt-5 text-left"
          onClick={onShowLog}
        >
          <Terminal className="size-4 text-muted-foreground" />
          <span className="flex-1">
            <span className="block text-xs font-medium">Request log</span>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              The last 100 provider calls: tokens, cost, time and errors.
            </span>
          </span>
          <span className="text-muted-foreground">↗</span>
        </button>
        {version && (
          <p className="mt-7 border-t pt-5 font-mono text-[10px] text-muted-foreground">
            {version === "dev"
              ? "FUSE development build · auto-update off"
              : `FUSE ${version} · updates install automatically`}
          </p>
        )}
      </div>
    </main>
  );
}

export function RequestLog({ rows }: { rows: RequestRow[] }) {
  if (rows.length === 0)
    return <p className="py-10 text-center text-sm text-muted-foreground">No requests yet.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-[10px] whitespace-nowrap">
        <thead className="bg-muted">
          <tr>
            {[
              "Time",
              "Provider / model",
              "In / out",
              "Cached / reasoning",
              "Cost",
              "Latency",
              "Status",
            ].map((label) => (
              <th key={label} className="px-3 py-3 font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t align-top">
              <td className="px-3 py-3 font-mono">{row.time}</td>
              <td className="px-3 py-3">
                {row.provider}
                <span className="mt-0.5 block text-muted-foreground">{row.model}</span>
              </td>
              <td className="px-3 py-3 font-mono">
                {number(row.input)} / {number(row.output)}
              </td>
              <td className="px-3 py-3 font-mono">
                {number(row.cached)} / {number(row.reasoning)}
              </td>
              <td className="px-3 py-3 font-mono">{row.cost === null ? "—" : money(row.cost)}</td>
              <td className="px-3 py-3 font-mono">{row.latency}</td>
              <td
                className={`max-w-72 px-3 py-3 whitespace-normal ${row.tone === "error" ? "text-destructive" : row.tone === "stopped" ? "text-muted-foreground" : ""}`}
              >
                {row.status}
                {row.requestId && (
                  <span className="mt-0.5 block font-mono text-[9px] text-muted-foreground select-all">
                    {row.requestId}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Settings → Recovery key (M1 C2): the way back in if the keychain loses the database key. */
function RecoveryKeySection({ load }: { load: () => Promise<string> }) {
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  return (
    <section className="mt-8 border-t pt-6" aria-label="Recovery key">
      <div className="mb-1 flex items-center gap-2">
        <LockKeyhole className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Recovery key</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Your chats are encrypted on this computer, with a key kept in the OS keychain. Save this
        recovery key in your password manager: you need it if the keychain loses the key (a Windows
        reset, or moving your data to a new PC).
      </p>
      {key ? (
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-lg bg-muted px-3 py-2 font-mono text-[11px] break-all select-all">
            {key}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(key).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setKey(null);
              setCopied(false);
            }}
          >
            Hide
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            load().then(setKey, (e: unknown) => {
              setError(String(e));
            });
          }}
        >
          Show recovery key
        </Button>
      )}
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
    </section>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="mt-4 flex items-center justify-between gap-3">
      <span className="text-xs">{label}</span>
      <div className="flex gap-1" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <Button
            key={o.value}
            size="sm"
            variant={o.value === value ? "secondary" : "ghost"}
            role="radio"
            aria-checked={o.value === value}
            className="text-xs"
            onClick={() => {
              onChange(o.value);
            }}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
