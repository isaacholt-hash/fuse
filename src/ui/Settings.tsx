import { money, number } from "./format";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  ChevronDown,
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
  Search,
  X,
} from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CloudProviderId } from "@/catalog/catalog";
import { openExternal } from "./openExternal";
import { Greyed, Modal } from "./primitives";
import type { KeyView, Motion, RequestRow, TextSize, Theme } from "./types";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_SECTIONS,
  settingsTarget,
  type SettingsCategoryId,
  type SettingsSectionId,
  type SettingsTargetId,
} from "./settingsRegistry";
import { PanelActivity, usePanelRequestGuard, usePanelLeave } from "./panelActivity";
import { searchSettings, focusSettingsTarget } from "./settingsSearch";
import {
  readSettingsCategory,
  rememberSettingsCategory,
  type SettingsLocation,
} from "./settingsNavigation";
import { WEB_REASONS } from "./webReasons";

function KeyResult({ state }: { state: KeyView }) {
  if (state.busy === "testing" || state.busy === "saving")
    return (
      <span role="status" className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        {state.busy === "saving" ? "Saving and testing…" : "Testing…"}
      </span>
    );
  if (!state.result) return null;
  const { tone, text } = state.result;
  return (
    <span
      role="status"
      className={`flex items-center gap-1.5 text-[12px] ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
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
  const formRef = useRef<HTMLFormElement>(null);
  usePanelLeave(() => {
    formRef.current?.reset();
    setHasInput(false);
    setReplacing(false);
    setConfirmDelete(false);
  });
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
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {state.provider === "openai" ? "GPT models" : "Claude models"}
          </p>
        </div>
        <a
          className="ml-auto flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
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
              ref={formRef}
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
                  <p className="text-[12px] text-muted-foreground">
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
  target,
  category: requestedCategory,
  navigationKey,
  onNavigate,
  onPanelLeave,
  notice,
  area = "chat",
  version,
  onCheckUpdates,
  onRecoveryKey,
  instructions,
  memory,
  routing,
  routingDiagnostics,
  budgets,
  prices,
  models,
  prompts,
  skills,
  modelDefaults,
  keyCaps,
  providerReports,
  local,
  python,
  mcp,
  connectors,
  quickCapture,
  dictation,
  notifications,
  data,
  appLock,
  importer,
  privacy,
  sync,
  agent,
  sandbox,
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
  web = false,
  server,
  hulk,
}: {
  /** Settings → HULK: pairing this desktop with FUSE on HULK (desktop only, M10 step 7). */
  target?: SettingsTargetId;
  category?: SettingsCategoryId;
  navigationKey?: number;
  onNavigate?: (location: SettingsLocation) => void;
  onPanelLeave?: () => void;
  notice?: string;
  area?: "chat" | "code";
  sync?: ReactNode;
  hulk?: ReactNode;
  /** PL-02: the web app on HULK; desktop-only settings are greyed with their reason. */
  web?: boolean;
  /** Settings → FUSE on HULK: the server's version, devices and Sign out (web app only). */
  server?: ReactNode;
  keys: KeyView[];
  /** The installed app version; null while it loads. */
  version: string | null;
  /** F1: "Check for updates" next to the version; resolves to what to say. */
  onCheckUpdates?: () => Promise<string>;
  /** The database recovery key, shown only when asked for. */
  onRecoveryKey: () => Promise<string>;
  /** Settings → Custom instructions; rendered once loaded. */
  instructions: ReactNode;
  /** Settings → Memory; rendered once loaded. */
  memory?: ReactNode;
  /** Settings → Routing test set; rendered once loaded. */
  routing?: ReactNode;
  routingDiagnostics?: ReactNode;
  /** Settings → Budgets (CO-03). */
  budgets?: ReactNode;
  /** Settings → Prices (MM-04). */
  prices?: ReactNode;
  /** Settings → Models (MM-03, MM-08). */
  models?: ReactNode;
  /** Settings → Prompt library (CH-12). */
  prompts?: ReactNode;
  skills?: ReactNode;
  /** Settings → Model defaults (MM-07). */
  modelDefaults?: ReactNode;
  /** Settings → Spend caps: the cost cap per run (AG-05) and caps per key (MM-09). */
  keyCaps?: ReactNode;
  /** M18.3: provider usage reports and the usage CSV. */
  providerReports?: ReactNode;
  /** Settings → Local model (M7, LL-03). */
  local?: ReactNode;
  /** M9 step 5: the Python runtime for data work. */
  python?: ReactNode;
  /** M9 step 8: MCP servers. */
  mcp?: ReactNode;
  connectors?: ReactNode;
  /** Settings → Quick capture (CH-08). */
  quickCapture?: ReactNode;
  dictation?: ReactNode;
  /** M10 step 21 (PL-07): sounds, system notifications, banners and quiet hours. */
  notifications?: ReactNode;
  /** Settings → Your data (SE-07). */
  data?: ReactNode;
  /** Settings → Privacy (SE-15): what's sent where, and providers allowed everywhere. */
  privacy?: ReactNode;
  /** Settings → Coding agent activity (AG-04). */
  agent?: ReactNode;
  sandbox?: ReactNode;
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
  onSaveKey: (provider: CloudProviderId, key: string) => void;
  onTestKey: (provider: CloudProviderId) => void;
  onDeleteKey: (provider: CloudProviderId) => void;
  onShowLog: () => void;
}) {
  const [category, setCategory] = useState<SettingsCategoryId>(
    () => settingsTarget(target ?? "")?.category ?? requestedCategory ?? readSettingsCategory(),
  );
  const [visited, setVisited] = useState<ReadonlySet<SettingsCategoryId>>(
    () => new Set([category]),
  );
  const [query, setQuery] = useState("");
  const [activeResult, setActiveResult] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{ id: SettingsTargetId } | null>(() =>
    target ? { id: target } : null,
  );
  const [highlight, setHighlight] = useState<{ id: SettingsTargetId } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const searching = query.trim() !== "";
  const results = useMemo(() => searchSettings(query), [query]);
  const [lastNavigation, setLastNavigation] = useState({
    target,
    requestedCategory,
    navigationKey,
  });
  if (
    target !== lastNavigation.target ||
    requestedCategory !== lastNavigation.requestedCategory ||
    navigationKey !== lastNavigation.navigationKey
  ) {
    setLastNavigation({ target, requestedCategory, navigationKey });
    setQuery("");
    setHighlight(null);
    setFocusRequest(target ? { id: target } : null);
    const next = settingsTarget(target ?? "")?.category ?? requestedCategory;
    if (next) {
      setCategory(next);
      setVisited((current) => new Set([...current, next]));
    }
  }
  useEffect(() => {
    rememberSettingsCategory(category);
  }, [category]);
  const content = useRef<HTMLDivElement>(null);
  const navigate = (next: SettingsCategoryId, id?: SettingsTargetId) => {
    onPanelLeave?.();
    setQuery("");
    setActiveResult(0);
    setFocusRequest(id ? { id } : null);
    setHighlight(null);
    setCategory(next);
    setVisited((current) => new Set([...current, next]));
    onNavigate?.(id ? { category: next, target: id } : { category: next });
    if (content.current) content.current.scrollTop = 0;
  };
  const openResult = (id: SettingsTargetId) => {
    const result = settingsTarget(id);
    if (result) navigate(result.category, id);
  };
  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const result = settingsTarget(focusRequest.id);
      if (!result || !content.current) return;
      const reduced =
        motion === "reduce" || document.documentElement.classList.contains("reduce-motion");
      if (focusSettingsTarget(content.current, result, reduced)) setHighlight({ id: result.id });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [focusRequest, motion]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => {
      setHighlight(null);
    }, 1800);
    return () => {
      clearTimeout(timer);
    };
  }, [highlight]);
  useEffect(() => {
    if (!searching) return;
    const result = results[activeResult];
    if (!result) return;
    const option = content.current?.querySelector<HTMLElement>(`#settings-result-${result.id}`);
    if (option && typeof option.scrollIntoView === "function")
      option.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [activeResult, results, searching]);
  const sections: Record<SettingsSectionId, ReactNode> = {
    appearance: (
      <>
        <section aria-label="Appearance">
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
            disabled={web}
          />
          {web && <Greyed>{WEB_REASONS.textSize}</Greyed>}
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
      </>
    ),
    "api-keys": (
      <>
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
        <div className="mt-4 flex items-start gap-2.5 text-[12px] leading-5 text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>
            {web
              ? "Keys are stored on HULK, encrypted by its system (systemd-creds), and never leave it except to call the provider."
              : "Keys are stored in your OS keychain and never leave this device except to call the provider."}
          </p>
        </div>
      </>
    ),
    notifications,
    "quick-capture": quickCapture,
    dictation,
    models,
    "model-defaults": modelDefaults,
    "routing-policy": routing,
    "local-model": local,
    instructions,
    memory,
    prompts,
    skills,
    budgets,
    "key-caps": keyCaps,
    "provider-reports": providerReports,
    prices,
    hulk,
    sandbox,
    python,
    mcp,
    connectors,
    sync,
    server,
    privacy,
    "app-lock": appLock,
    "database-recovery": <RecoveryKeySection load={onRecoveryKey} />,
    import: importer,
    data,
    version: version ? <VersionLine version={version} onCheck={onCheckUpdates} web={web} /> : null,
    "request-log": (
      <>
        <button
          className="mt-7 flex w-full items-center gap-3 border-t pt-5 text-left"
          onClick={onShowLog}
        >
          <Terminal className="size-4 text-muted-foreground" />
          <span className="flex-1">
            <span className="block text-xs font-medium">Request log</span>
            <span className="mt-1 block text-[12px] text-muted-foreground">
              The last 100 provider calls: tokens, cost, time and errors.
            </span>
          </span>
          <span className="text-muted-foreground">↗</span>
        </button>
      </>
    ),
    "agent-activity": agent,
    "routing-diagnostics": routingDiagnostics,
  };
  const selected =
    SETTINGS_CATEGORIES.find((item) => item.id === category) ?? SETTINGS_CATEGORIES[0];
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Settings">
      <header className="flex min-h-[66px] shrink-0 flex-wrap items-center gap-4 border-b px-5 py-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          Back to {area === "code" ? "Code" : "Chat"}
        </Button>
        <h1 className="text-lg font-medium">Settings</h1>
        <div className="relative w-full min-[800px]:ml-auto min-[800px]:w-[320px]">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={search}
            autoFocus
            aria-label="Search settings"
            placeholder="Search settings"
            className="pr-10 pl-9"
            value={query}
            role="combobox"
            aria-expanded={searching}
            aria-controls={searching ? "settings-results" : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              searching && results[activeResult]
                ? `settings-result-${results[activeResult].id}`
                : undefined
            }
            onChange={(event) => {
              if (!searching && event.target.value.trim()) onPanelLeave?.();
              setQuery(event.target.value);
              setActiveResult(0);
              setFocusRequest(null);
              setHighlight(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
                setFocusRequest(null);
                return;
              }
              if (!searching || results.length === 0) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveResult((index) =>
                  event.key === "ArrowDown"
                    ? Math.min(index + 1, results.length - 1)
                    : Math.max(index - 1, 0),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                const result = results[activeResult];
                if (result) openResult(result.id);
              }
            }}
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear settings search"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => {
                setQuery("");
                setFocusRequest(null);
                search.current?.focus();
              }}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col min-[800px]:flex-row">
        <aside className="hidden w-[220px] shrink-0 overflow-y-auto border-r bg-paper p-3 min-[800px]:block">
          <nav aria-label="Settings categories" className="space-y-1">
            {SETTINGS_CATEGORIES.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                className={`h-auto w-full justify-start px-3 py-2 text-left text-sm whitespace-normal ${!searching && category === item.id ? "bg-accent font-medium" : "text-muted-foreground"}`}
                aria-current={!searching && category === item.id ? "page" : undefined}
                onClick={() => {
                  navigate(item.id);
                }}
              >
                {item.label}
              </Button>
            ))}
          </nav>
        </aside>
        <div className="shrink-0 border-b bg-paper px-5 py-3 min-[800px]:hidden">
          <label htmlFor="settings-category" className="mb-1 block text-xs text-muted-foreground">
            Settings category
          </label>
          <div className="relative">
            <select
              id="settings-category"
              aria-label="Settings category"
              className="w-full appearance-none rounded-md border bg-background py-2 pr-9 pl-3 text-sm text-foreground [color-scheme:light] dark:[color-scheme:dark]"
              value={searching ? "" : category}
              onChange={(event) => {
                const next = SETTINGS_CATEGORIES.find((item) => item.id === event.target.value);
                if (next) navigate(next.id);
              }}
            >
              {searching && (
                <option value="" disabled>
                  Search results
                </option>
              )}
              {SETTINGS_CATEGORIES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </div>
        <div
          ref={content}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-7 min-[800px]:px-8"
        >
          <div className="mx-auto max-w-[760px]">
            {notice && (
              <p role="status" className="mb-4 text-sm text-muted-foreground">
                {notice}
              </p>
            )}
            <h2 className="text-xl font-medium" id="settings-category-title">
              {searching ? "Search results" : selected.label}
            </h2>
            <p className="mt-1 mb-7 text-sm text-muted-foreground">
              {searching ? "Across all settings" : selected.description}
            </p>
            {!searching &&
              (category === "code-tools" ||
                category === "providers-models" ||
                category === "privacy-security") && (
                <p className="mb-6 text-xs text-muted-foreground">
                  Project overrides stay in project settings. Run mode, cost caps, time limits and
                  tool permissions apply to the project where they are set.
                </p>
              )}
            {!searching && category === "personalization" && (
              <p className="mb-6 text-xs text-muted-foreground">
                For instructions and memory that apply to one project, open that project's settings
                from the conversation sidebar.
              </p>
            )}
            {searching && (
              <>
                <p role="status" className="mb-3 text-xs text-muted-foreground">
                  {results.length
                    ? `${String(results.length)} ${results.length === 1 ? "setting" : "settings"} found`
                    : "No settings found. Try another word."}
                </p>
                <div
                  id="settings-results"
                  role="listbox"
                  aria-label="Settings results"
                  className="space-y-1"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setQuery("");
                      setFocusRequest(null);
                      search.current?.focus();
                    }
                    if (
                      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                      results.length > 0
                    ) {
                      event.preventDefault();
                      const next =
                        event.key === "ArrowDown"
                          ? Math.min(activeResult + 1, results.length - 1)
                          : Math.max(activeResult - 1, 0);
                      setActiveResult(next);
                      const result = results[next];
                      if (result)
                        content.current
                          ?.querySelector<HTMLElement>(`#settings-result-${result.id}`)
                          ?.focus();
                    }
                  }}
                >
                  {results.map((result, index) => (
                    <button
                      key={result.id}
                      id={`settings-result-${result.id}`}
                      role="option"
                      tabIndex={activeResult === index ? 0 : -1}
                      aria-selected={activeResult === index}
                      className={`flex w-full scroll-mt-4 flex-col gap-1 rounded-md px-3 py-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${activeResult === index ? "bg-accent" : ""}`}
                      onMouseMove={() => {
                        setActiveResult(index);
                      }}
                      onClick={() => {
                        openResult(result.id);
                      }}
                    >
                      <span className="text-sm font-medium">{result.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {SETTINGS_CATEGORIES.find((item) => item.id === result.category)?.label} →{" "}
                        {result.id !== result.section && (
                          <>
                            {SETTINGS_SECTIONS.find((item) => item.id === result.section)?.label}{" "}
                            →{" "}
                          </>
                        )}
                        {result.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{result.description}</span>
                      {web && result.availability === "desktop" && (
                        <span className="text-xs text-muted-foreground">
                          {result.id === "text-size"
                            ? WEB_REASONS.textSize
                            : "Managed in the desktop app. Open this setting for details."}
                        </span>
                      )}
                      {!web && result.availability === "web" && (
                        <span className="text-xs text-muted-foreground">
                          Manage this in the web app on HULK.
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
            {SETTINGS_CATEGORIES.filter((item) => visited.has(item.id)).map((item) => (
              <PanelActivity key={item.id} value={!searching && category === item.id}>
                <div
                  hidden={searching || category !== item.id}
                  inert={searching || category !== item.id}
                  className="space-y-8"
                  aria-label={`${item.label} settings`}
                >
                  {SETTINGS_SECTIONS.filter((section) => section.category === item.id).map(
                    (section) => (
                      <div
                        key={section.id}
                        data-settings-section={section.id}
                        data-highlighted={
                          highlight && settingsTarget(highlight.id)?.section === section.id
                            ? "true"
                            : undefined
                        }
                        className={`scroll-mt-5 rounded-md [&>section]:mt-0 [&>section]:border-t-0 [&>section]:pt-0 ${highlight && settingsTarget(highlight.id)?.section === section.id ? "bg-muted/50 ring-1 ring-border" : ""}`}
                      >
                        {hasSettingsContent(sections[section.id]) ? (
                          sections[section.id]
                        ) : (
                          <section aria-label={section.label}>
                            <h2 className="text-sm font-medium">{section.label}</h2>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {section.description} {unavailableSetting(section.id, web)}
                            </p>
                          </section>
                        )}
                      </div>
                    ),
                  )}
                </div>
              </PanelActivity>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

function hasSettingsContent(node: ReactNode): boolean {
  return Children.toArray(node).some((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? hasSettingsContent(child.props.children)
      : true,
  );
}
function unavailableSetting(section: SettingsSectionId, web: boolean): string {
  if (section === "sandbox" && !web)
    return "Sandbox preferences are available on Windows; Linux uses its OS sandbox automatically.";
  if (web && section === "hulk")
    return "The web app already runs on HULK. Pair a desktop from its Code & tools settings.";
  if (!web && section === "server")
    return "Manage server devices and sign out in the web app on HULK.";
  return "Unavailable in this installation.";
}

/** The installed version, and F1's "Check for updates" with what it found. */
function VersionLine({
  version,
  onCheck,
  web,
}: {
  version: string;
  onCheck?: (() => Promise<string>) | undefined;
  /** The web app shows the server's version (PL-06); it's updated with the server. */
  web: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-5 font-mono text-[11px] text-muted-foreground">
      <span>
        {web
          ? `FUSE on HULK ${version} · ${WEB_REASONS.update}`
          : version === "dev"
            ? "FUSE development build · auto-update off"
            : `FUSE ${version} · updates install automatically`}
      </span>
      {onCheck && version !== "dev" && !web && (
        <button
          className="underline underline-offset-2 hover:text-foreground disabled:opacity-60"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setNote(null);
            onCheck().then(
              (n) => {
                setNote(n);
                setBusy(false);
              },
              (e: unknown) => {
                setNote(String(e));
                setBusy(false);
              },
            );
          }}
        >
          {busy ? "Checking…" : "Check for updates"}
        </button>
      )}
      {note && <span role="status">{note}</span>}
    </div>
  );
}

export function RequestLog({ rows }: { rows: RequestRow[] }) {
  if (rows.length === 0)
    return <p className="py-10 text-center text-sm text-muted-foreground">No requests yet.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-[12px] whitespace-nowrap">
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
                  <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground select-all">
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
  const requestGuard = usePanelRequestGuard();
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  usePanelLeave(() => {
    setKey(null);
    setCopied(false);
  });
  return (
    <section className="mt-8 border-t pt-6" aria-label="Recovery key">
      <div className="mb-1 flex items-center gap-2">
        <LockKeyhole className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Recovery key</h2>
      </div>
      <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
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
            const current = requestGuard();
            load().then(
              (value) => {
                if (current()) setKey(value);
              },
              (e: unknown) => {
                setError(String(e));
              },
            );
          }}
        >
          Show recovery key
        </Button>
      )}
      {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
    </section>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
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
            disabled={disabled}
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
