import { ShieldCheck } from "lucide-react";

export type PrivacyModeView = "normal" | "local_only" | "cloud_only";

export interface ProviderRuleView {
  id: "anthropic" | "openai";
  name: string;
  /** This project's own rule; null follows the global one. */
  own: boolean | null;
  /** Whether it's allowed everywhere else (the global rule). */
  global: boolean;
}

export interface ProjectPrivacyProps {
  mode: PrivacyModeView;
  allowEmbeddings: boolean;
  providers: ProviderRuleView[];
  onChange: (change: { mode: PrivacyModeView; allowEmbeddings: boolean }) => void;
  onProvider: (provider: ProviderRuleView["id"], allow: boolean | null) => void;
}

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-xs";

const MODES: Record<PrivacyModeView, string> = {
  normal: "Normal: send to the providers allowed below",
  local_only: "Local only: nothing leaves this computer",
  cloud_only: "Cloud only: never a local model",
};

/**
 * Project settings → Privacy (SE-13): which providers may receive this project's content, and
 * whether it may be embedded for search. Blocked content is never sent; a send says why.
 */
export function ProjectPrivacySection({
  mode,
  allowEmbeddings,
  providers,
  onChange,
  onProvider,
}: ProjectPrivacyProps) {
  return (
    <section aria-label="Project privacy">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-medium">Privacy</h3>
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground">
        Where this project&apos;s chats, memories, decisions and files may be sent. FUSE checks this
        before every request and never sends what it blocks.
      </p>
      <select
        aria-label="Privacy mode"
        className={`${selectClass} w-full`}
        value={mode}
        onChange={(e) => {
          onChange({ mode: e.target.value as PrivacyModeView, allowEmbeddings });
        }}
      >
        {(Object.keys(MODES) as PrivacyModeView[]).map((m) => (
          <option key={m} value={m}>
            {MODES[m]}
          </option>
        ))}
      </select>
      {mode === "local_only" && (
        <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
          FUSE has no local model yet, so chats in this project can&apos;t be answered until local
          models arrive or you change this.
        </p>
      )}
      <div className="mt-2 space-y-1 text-xs">
        {providers.map((p) => (
          <label key={p.id} className="flex items-center gap-2">
            <span className="w-20">{p.name}</span>
            <select
              aria-label={`${p.name} in this project`}
              className={selectClass}
              value={p.own === null ? "default" : p.own ? "allow" : "block"}
              onChange={(e) => {
                const v = e.target.value;
                onProvider(p.id, v === "default" ? null : v === "allow");
              }}
            >
              <option value="default">As everywhere ({p.global ? "allowed" : "blocked"})</option>
              <option value="allow">Allowed</option>
              <option value="block">Blocked</option>
            </select>
          </label>
        ))}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={allowEmbeddings}
            onChange={(e) => {
              onChange({ mode, allowEmbeddings: e.target.checked });
            }}
          />
          Send content to a provider to search by meaning (embeddings)
        </label>
      </div>
    </section>
  );
}
