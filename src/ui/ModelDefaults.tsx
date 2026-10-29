import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: { id: Effort | ""; label: string }[] = [
  { id: "", label: "Automatic" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Maximum" },
];

export interface DefaultsValue {
  maxOutputTokens?: number;
  effort?: Effort;
  prefix?: string;
}

/**
 * Settings → Model defaults (MM-07): max output, reasoning effort and a prompt prefix for a
 * tier, a model or a project. Project beats model beats tier.
 */
export function ModelDefaultsSection({
  scopes,
  values,
  onSave,
}: {
  scopes: { key: string; label: string; group: string }[];
  values: Record<string, DefaultsValue>;
  /** null clears that scope's defaults. */
  onSave: (key: string, value: DefaultsValue | null) => void;
}) {
  const [scope, setScope] = useState(scopes[0]?.key ?? "");
  const current = values[scope] ?? {};
  const [form, setForm] = useState<{ max: string; effort: Effort | ""; prefix: string }>({
    max: current.maxOutputTokens ? String(current.maxOutputTokens) : "",
    effort: current.effort ?? "",
    prefix: current.prefix ?? "",
  });
  const [status, setStatus] = useState<string | null>(null);
  const pick = (key: string) => {
    const v = values[key] ?? {};
    setScope(key);
    setForm({
      max: v.maxOutputTokens ? String(v.maxOutputTokens) : "",
      effort: v.effort ?? "",
      prefix: v.prefix ?? "",
    });
    setStatus(null);
  };
  const max = form.max.trim() === "" ? undefined : Number(form.max);
  const valid = max === undefined || (Number.isInteger(max) && max >= 256);
  const set = scopes.filter((s) => values[s.key]);
  const groups = [...new Set(scopes.map((s) => s.group))];
  return (
    <section className="mt-8 border-t pt-6" aria-label="Model defaults">
      <div className="mb-1 flex items-center gap-2">
        <SlidersHorizontal className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Model defaults</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        For a tier, a model or a project: the most a model may write, how hard it reasons, and text
        put before every prompt. A project&apos;s beat a model&apos;s, which beat a tier&apos;s.
        &ldquo;Think harder&rdquo; still asks for the maximum. Temperature isn&apos;t offered:
        neither provider accepts one on its current models.
      </p>
      {set.length > 0 && (
        <p className="mb-2 text-[11px] text-muted-foreground">
          Set for: {set.map((s) => s.label).join(", ")}
        </p>
      )}
      <label className="mb-2 flex items-center gap-2 text-xs">
        For
        <select
          aria-label="Defaults for"
          className="h-8 rounded-lg border bg-transparent px-2 text-xs"
          value={scope}
          onChange={(e) => {
            pick(e.target.value);
          }}
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {scopes
                .filter((s) => s.group === g)
                .map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <label className="flex flex-col gap-1">
          Max output tokens (blank: the model&apos;s own)
          <Input
            aria-label="Max output tokens"
            inputMode="numeric"
            className="h-8 text-xs"
            value={form.max}
            onChange={(e) => {
              setForm((f) => ({ ...f, max: e.target.value }));
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          Reasoning effort
          <select
            aria-label="Reasoning effort"
            className="h-8 rounded-lg border bg-transparent px-2 text-xs"
            value={form.effort}
            onChange={(e) => {
              setForm((f) => ({ ...f, effort: e.target.value as Effort | "" }));
            }}
          >
            {EFFORTS.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          Put before every prompt
          <textarea
            aria-label="Prompt prefix"
            rows={2}
            className="w-full resize-y rounded-md border bg-transparent px-2 py-1.5 text-xs"
            value={form.prefix}
            onChange={(e) => {
              setForm((f) => ({ ...f, prefix: e.target.value }));
            }}
          />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!valid || !scope}
          onClick={() => {
            const value: DefaultsValue = {
              ...(max ? { maxOutputTokens: max } : {}),
              ...(form.effort ? { effort: form.effort } : {}),
              ...(form.prefix.trim() ? { prefix: form.prefix.trim() } : {}),
            };
            onSave(scope, Object.keys(value).length ? value : null);
            setStatus("Saved.");
          }}
        >
          Save
        </Button>
        {values[scope] && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onSave(scope, null);
              setForm({ max: "", effort: "", prefix: "" });
              setStatus("Cleared.");
            }}
          >
            Clear
          </Button>
        )}
        {!valid && <span className="text-[11px] text-destructive">At least 256 tokens.</span>}
        {status && (
          <span role="status" className="text-[11px] text-muted-foreground">
            {status}
          </span>
        )}
      </div>
    </section>
  );
}
