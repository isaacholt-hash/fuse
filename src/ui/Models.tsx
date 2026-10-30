import type { ProviderId } from "@/catalog/catalog";
import { Boxes, CircleAlert, LoaderCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Provider = ProviderId;
const PROVIDER_NAME: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  local: "Local model",
};

export interface ModelCheckView {
  /** e.g. "Oct 28" */
  checked: string;
  found: { provider: Provider; id: string; displayName: string }[];
  missing: {
    provider: Provider;
    id: string;
    displayName: string;
    tiers: string[];
    replacement: string | null;
  }[];
  failed: Provider[];
}

export interface NewModelForm {
  provider: Provider;
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  /** US dollars per 1M tokens. */
  input: number;
  output: number;
  vision: boolean;
}

const EMPTY = {
  provider: "anthropic" as Provider,
  id: "",
  displayName: "",
  contextWindow: "200000",
  maxOutput: "32000",
  input: "",
  output: "",
  vision: true,
};

/** Settings → Models (MM-03, MM-08): the providers' lists against the catalog, and models you add. */
export function ModelsSection({
  check,
  custom,
  canCheck,
  onCheck,
  onAdd,
  onRemove,
}: {
  check: ModelCheckView | null;
  /** Models you added by hand. */
  custom: { key: string; name: string }[];
  /** False with no keys saved. */
  canCheck: boolean;
  onCheck: () => Promise<void>;
  onAdd: (model: NewModelForm) => void;
  onRemove: (key: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const valid =
    form.id.trim() !== "" &&
    [form.contextWindow, form.maxOutput].every((v) => Number.isInteger(num(v)) && num(v) > 0) &&
    [form.input, form.output].every((v) => Number.isFinite(num(v)) && num(v) >= 0);
  const field = (key: "id" | "displayName" | "contextWindow" | "maxOutput" | "input" | "output") =>
    ({
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setForm((f) => ({ ...f, [key]: e.target.value }));
      },
    }) as const;
  return (
    <section className="mt-8 border-t pt-6" aria-label="Models">
      <div className="mb-1 flex items-center gap-2">
        <Boxes className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Models</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        FUSE reads each provider&apos;s model list once a week. New models can be added with their
        prices; a model a provider stops listing is flagged here.
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !canCheck}
          onClick={() => {
            setBusy(true);
            setError(null);
            onCheck().then(
              () => {
                setBusy(false);
              },
              (err: unknown) => {
                setBusy(false);
                setError(err instanceof Error ? err.message : String(err));
              },
            );
          }}
        >
          {busy && <LoaderCircle className="size-3 animate-spin" />}
          Check providers now
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {!canCheck
            ? "Add a key first."
            : check
              ? `Last checked ${check.checked}.`
              : "Not checked yet."}
        </span>
      </div>
      {error && (
        <p role="status" className="mt-2 text-[11px] text-destructive">
          {error}
        </p>
      )}
      {check && check.failed.length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Couldn&apos;t read the list from {check.failed.map((p) => PROVIDER_NAME[p]).join(" or ")}.
        </p>
      )}
      {check && check.missing.length > 0 && (
        <ul className="mt-3 space-y-1.5" aria-label="Models no longer listed">
          {check.missing.map((m) => (
            <li
              key={`${m.provider}/${m.id}`}
              className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              <span>
                <strong className="font-medium">{m.displayName}</strong> is no longer listed by{" "}
                {PROVIDER_NAME[m.provider]}
                {m.tiers.length > 0 && ` (used by ${m.tiers.join(" and ")})`}.
                {m.replacement && ` Its newest replacement is ${m.replacement}.`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {check && check.found.length > 0 && (
        <div className="mt-3" aria-label="New models">
          <p className="mb-1 text-xs font-medium">New from the providers</p>
          <ul className="space-y-1">
            {check.found.map((m) => (
              <li key={`${m.provider}/${m.id}`} className="flex items-center gap-2 text-xs">
                <span className="flex-1 truncate">
                  {m.displayName}{" "}
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {PROVIDER_NAME[m.provider]} · {m.id}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setForm({
                      ...EMPTY,
                      provider: m.provider,
                      id: m.id,
                      displayName: m.displayName,
                    });
                  }}
                >
                  Add…
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <form
        className="mt-4 grid grid-cols-2 gap-2 text-[11px]"
        aria-label="Add a model"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onAdd({
            provider: form.provider,
            id: form.id.trim(),
            displayName: form.displayName.trim() || form.id.trim(),
            contextWindow: num(form.contextWindow),
            maxOutput: num(form.maxOutput),
            input: num(form.input),
            output: num(form.output),
            vision: form.vision,
          });
          setForm(EMPTY);
        }}
      >
        <p className="col-span-2 text-xs font-medium">Add a model</p>
        <label className="flex flex-col gap-1">
          Provider
          <select
            className="h-8 rounded-lg border bg-transparent px-2 text-xs"
            value={form.provider}
            onChange={(e) => {
              setForm((f) => ({ ...f, provider: e.target.value as Provider }));
            }}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Model id
          <Input className="h-8 text-xs" placeholder="e.g. claude-sonnet-5-6" {...field("id")} />
        </label>
        <label className="flex flex-col gap-1">
          Name
          <Input className="h-8 text-xs" {...field("displayName")} />
        </label>
        <label className="flex flex-col gap-1">
          Context window (tokens)
          <Input className="h-8 text-xs" inputMode="numeric" {...field("contextWindow")} />
        </label>
        <label className="flex flex-col gap-1">
          Input $ per 1M tokens
          <Input className="h-8 text-xs" inputMode="decimal" {...field("input")} />
        </label>
        <label className="flex flex-col gap-1">
          Output $ per 1M tokens
          <Input className="h-8 text-xs" inputMode="decimal" {...field("output")} />
        </label>
        <label className="flex flex-col gap-1">
          Max output (tokens)
          <Input className="h-8 text-xs" inputMode="numeric" {...field("maxOutput")} />
        </label>
        <label className="flex items-center gap-2 self-end pb-2">
          <input
            type="checkbox"
            checked={form.vision}
            onChange={(e) => {
              setForm((f) => ({ ...f, vision: e.target.checked }));
            }}
          />
          Reads images
        </label>
        <div className="col-span-2">
          <Button size="sm" type="submit" disabled={!valid}>
            Add model
          </Button>
        </div>
      </form>
      {custom.length > 0 && (
        <ul className="mt-3 space-y-1" aria-label="Models you added">
          {custom.map((m) => (
            <li key={m.key} className="flex items-center gap-2 text-xs">
              <span className="flex-1">
                {m.name}{" "}
                <span className="font-mono text-[10px] text-muted-foreground">{m.key}</span>
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${m.name}`}
                onClick={() => {
                  onRemove(m.key);
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
