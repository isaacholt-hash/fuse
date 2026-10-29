import { ArrowDown, ArrowUp, Download, Plus, Route, Trash2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Complexity, Intent, Rule, RoutingPolicy, TierId } from "@/routing/policy";

const INTENTS: { id: Intent; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "writing", label: "Writing" },
  { id: "coding", label: "Coding" },
  { id: "analysis", label: "Analysis" },
  { id: "long_document", label: "Long document" },
  { id: "reasoning", label: "Reasoning" },
  { id: "vision", label: "Images" },
  { id: "creative", label: "Creative" },
];
const COMPLEXITIES: { id: Complexity; label: string }[] = [
  { id: "low", label: "Simple" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "Hard" },
];
const ANSWER_TIERS: { id: Exclude<TierId, "cheap">; label: string }[] = [
  { id: "balanced", label: "Balanced" },
  { id: "best", label: "Best" },
];

export interface PolicyScoreView {
  before: { correct: number; total: number };
  after: { correct: number; total: number };
  /** Prompts whose tier changes. */
  changed: number;
}

export interface PolicyModelOption {
  key: string;
  name: string;
  provider: "anthropic" | "openai";
  id: string;
}

const pct = (s: { correct: number; total: number }) =>
  s.total === 0 ? "—" : `${String(Math.round((s.correct / s.total) * 100))}%`;

const chip = (on: boolean) =>
  `rounded-full border px-2 py-0.5 text-[10px] ${on ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-accent"}`;

/**
 * Settings → Routing policy (RT-03, RT-16): tiers, the quality floor, provider preference and
 * the rules, for all chats or one project. A change is scored on the routing test set first.
 */
export function PolicyEditor({
  policy,
  isCustom,
  projects,
  projectRules,
  models,
  problems,
  score,
  onSave,
  onSaveProject,
  onReset,
  onImport,
  onExport,
}: {
  policy: RoutingPolicy;
  /** You saved your own (not the shipped one). */
  isCustom: boolean;
  projects: { id: string; name: string }[];
  projectRules: Record<string, Rule[]>;
  models: PolicyModelOption[];
  /** What's wrong with a draft (unknown models, empty tiers); empty when fine. */
  problems: (draft: RoutingPolicy) => string[];
  /** Scores a change on the routing test set; null when there's no test set. */
  score: (before: RoutingPolicy, after: RoutingPolicy) => PolicyScoreView | null;
  onSave: (draft: RoutingPolicy) => void;
  onSaveProject: (projectId: string, rules: Rule[]) => void;
  onReset: () => void;
  /** Reads a policy file; throws with what's wrong. */
  onImport: (text: string) => RoutingPolicy;
  onExport?: (draft: RoutingPolicy) => void;
}) {
  const [scope, setScope] = useState<string | null>(null);
  const [draft, setDraft] = useState(policy);
  const [rules, setRules] = useState<Rule[]>(policy.rules);
  // The draft as it was when last scored: Save needs a score of exactly what's saved.
  const [tested, setTested] = useState<{ key: string; result: PolicyScoreView | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const isProject = scope !== null;
  const current: RoutingPolicy = isProject ? draft : { ...draft, rules };
  const key = JSON.stringify(isProject ? rules : current);
  const issues = isProject ? [] : problems(current);
  // A project's rules are tried before the global ones.
  const withRules = (rs: Rule[]) => ({ ...policy, rules: [...rs, ...policy.rules] });
  const before = scope === null ? policy : withRules(projectRules[scope] ?? []);
  const after = scope === null ? current : withRules(rules);
  // A newly saved or reset policy replaces the draft.
  const [shown, setShown] = useState(policy);
  if (shown !== policy) {
    setShown(policy);
    setDraft(policy);
    if (scope === null) setRules(policy.rules);
    setTested(null);
  }
  const ready = tested?.key === key && issues.length === 0;
  const changed = (next: () => void) => {
    next();
    setSaved(null);
  };
  const switchScope = (next: string | null) => {
    setScope(next);
    setDraft(policy);
    setRules(next === null ? policy.rules : (projectRules[next] ?? []));
    setTested(null);
    setError(null);
    setSaved(null);
  };
  const setRule = (i: number, rule: Rule) => {
    changed(() => {
      setRules((rs) => rs.map((r, j) => (j === i ? rule : r)));
    });
  };
  const move = (i: number, by: number) => {
    changed(() => {
      setRules((rs) => {
        const out = [...rs];
        const [r] = out.splice(i, 1);
        if (r) out.splice(i + by, 0, r);
        return out;
      });
    });
  };
  const used = new Set(draft.tiers.flatMap((t) => t.models.map((m) => `${m.provider}/${m.id}`)));
  // The global list ends with a catch-all that stays last; a project's list has none.
  const fixedLast = !isProject;
  const editable = fixedLast ? rules.length - 1 : rules.length;
  return (
    <section className="mt-8 border-t pt-6" aria-label="Routing policy">
      <div className="mb-1 flex items-center gap-2">
        <Route className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Routing policy</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        Which tier Auto starts each message on. Rules are tried top to bottom and the first match
        wins; the quality floor still applies. A change is scored on your routing test set before it
        can be saved.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-2">
          Rules for
          <select
            aria-label="Rules for"
            className="h-8 rounded-lg border bg-transparent px-2 text-xs"
            value={scope ?? ""}
            onChange={(e) => {
              switchScope(e.target.value || null);
            }}
          >
            <option value="">All chats</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                Project: {p.name}
              </option>
            ))}
          </select>
        </label>
        {!isProject && (
          <>
            <input
              ref={picker}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Policy file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                file.text().then(
                  (text) => {
                    try {
                      const next = onImport(text);
                      setDraft(next);
                      setRules(next.rules);
                      setTested(null);
                      setError(null);
                      setSaved("Imported. Test it, then save.");
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  },
                  (err: unknown) => {
                    setError(String(err));
                  },
                );
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                picker.current?.click();
              }}
            >
              <Upload className="size-3" />
              Import…
            </Button>
            {onExport && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onExport(current);
                }}
              >
                <Download className="size-3" />
                Export…
              </Button>
            )}
            {isCustom && (
              <Button size="sm" variant="ghost" onClick={onReset}>
                Back to the default policy
              </Button>
            )}
          </>
        )}
      </div>

      {!isProject && (
        <div className="mb-4 space-y-2" aria-label="Tiers">
          {draft.tiers.map((tier) => (
            <div key={tier.id} className="rounded-lg border p-2 text-xs">
              <p className="mb-1 font-medium">
                {tier.label}{" "}
                <span className="font-normal text-muted-foreground">{tier.description}</span>
              </p>
              <div className="flex flex-wrap items-center gap-1">
                {tier.models.map((m) => {
                  const name = models.find((o) => o.key === `${m.provider}/${m.id}`)?.name ?? m.id;
                  return (
                    <span
                      key={`${m.provider}/${m.id}`}
                      className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]"
                    >
                      {name}
                      <button
                        aria-label={`Remove ${name} from ${tier.label}`}
                        onClick={() => {
                          changed(() => {
                            setDraft((d) => ({
                              ...d,
                              tiers: d.tiers.map((t) =>
                                t.id === tier.id
                                  ? { ...t, models: t.models.filter((x) => x !== m) }
                                  : t,
                              ),
                            }));
                          });
                        }}
                      >
                        <X className="size-2.5" />
                      </button>
                    </span>
                  );
                })}
                <select
                  aria-label={`Add a model to ${tier.label}`}
                  className="h-6 rounded border bg-transparent px-1 text-[10px]"
                  value=""
                  onChange={(e) => {
                    const m = models.find((o) => o.key === e.target.value);
                    if (!m) return;
                    changed(() => {
                      setDraft((d) => ({
                        ...d,
                        tiers: d.tiers.map((t) =>
                          t.id === tier.id
                            ? { ...t, models: [...t.models, { provider: m.provider, id: m.id }] }
                            : t,
                        ),
                      }));
                    });
                  }}
                >
                  <option value="">+ model</option>
                  {models
                    .filter((m) => !used.has(m.key))
                    .map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-2">
              Lowest tier that answers
              <select
                aria-label="Quality floor"
                className="h-7 rounded border bg-transparent px-1 text-xs"
                value={draft.floor.default}
                onChange={(e) => {
                  const tier = e.target.value as TierId;
                  changed(() => {
                    setDraft((d) => ({ ...d, floor: { ...d.floor, default: tier } }));
                  });
                }}
              >
                {ANSWER_TIERS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              On a price tie, prefer
              <select
                aria-label="Provider preference"
                className="h-7 rounded border bg-transparent px-1 text-xs"
                value={draft.providerPreference[0] ?? ""}
                onChange={(e) => {
                  const p = e.target.value;
                  changed(() => {
                    setDraft((d) => ({
                      ...d,
                      providerPreference:
                        p === "anthropic"
                          ? ["anthropic", "openai"]
                          : p === "openai"
                            ? ["openai", "anthropic"]
                            : [],
                    }));
                  });
                }}
              >
                <option value="">No preference</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
            </label>
          </div>
        </div>
      )}

      <ol className="space-y-2" aria-label="Rules">
        {rules.map((rule, i) => {
          const last = fixedLast && i === rules.length - 1;
          const toggle = <T extends string>(list: T[] | undefined, v: T): T[] | undefined => {
            const next = list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v];
            return next.length ? next : undefined;
          };
          const when = (patch: Partial<Rule["when"]>) => {
            const next = { ...rule.when, ...patch };
            for (const k of Object.keys(next) as (keyof Rule["when"])[]) {
              if (next[k] === undefined) Reflect.deleteProperty(next, k);
            }
            setRule(i, { ...rule, when: next });
          };
          return (
            <li key={rule.id} className="rounded-lg border p-2 text-xs" aria-label={rule.reason}>
              {last ? (
                <p className="mb-1.5 font-medium">Everything else</p>
              ) : (
                <div className="mb-1.5 space-y-1">
                  <div className="flex flex-wrap gap-1" aria-label="Kinds of question">
                    {INTENTS.map((t) => (
                      <button
                        key={t.id}
                        aria-pressed={rule.when.intents?.includes(t.id) ?? false}
                        className={chip(rule.when.intents?.includes(t.id) ?? false)}
                        onClick={() => {
                          when({ intents: toggle(rule.when.intents, t.id) });
                        }}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1" aria-label="Difficulty">
                    {COMPLEXITIES.map((c) => (
                      <button
                        key={c.id}
                        aria-pressed={rule.when.complexities?.includes(c.id) ?? false}
                        className={chip(rule.when.complexities?.includes(c.id) ?? false)}
                        onClick={() => {
                          when({ complexities: toggle(rule.when.complexities, c.id) });
                        }}
                      >
                        {c.label}
                      </button>
                    ))}
                    {rule.when.capabilities && (
                      <span className="text-[10px] text-muted-foreground">
                        and needs {rule.when.capabilities.join(" or ")}
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">→</span>
                <select
                  aria-label="Start on"
                  className="h-7 rounded border bg-transparent px-1 text-xs"
                  value={rule.tier}
                  onChange={(e) => {
                    setRule(i, { ...rule, tier: e.target.value as TierId });
                  }}
                >
                  {ANSWER_TIERS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label="Reason shown with the answer"
                  className="h-7 flex-1 text-xs"
                  value={rule.reason}
                  onChange={(e) => {
                    setRule(i, { ...rule, reason: e.target.value });
                  }}
                />
                {!last && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Move up"
                      disabled={i === 0}
                      onClick={() => {
                        move(i, -1);
                      }}
                    >
                      <ArrowUp className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Move down"
                      disabled={i >= editable - 1}
                      onClick={() => {
                        move(i, 1);
                      }}
                    >
                      <ArrowDown className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Delete rule"
                      onClick={() => {
                        changed(() => {
                          setRules((rs) => rs.filter((_, j) => j !== i));
                        });
                      }}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <Button
        size="sm"
        variant="ghost"
        className="mt-1"
        onClick={() => {
          changed(() => {
            setRules((rs) => {
              const ids = new Set(rs.map((r) => r.id));
              let n = rs.length + 1;
              while (ids.has(`rule-${String(n)}`)) n += 1;
              const rule: Rule = {
                id: `rule-${String(n)}`,
                when: { intents: ["writing"] },
                tier: "best",
                reason: "New rule",
              };
              return fixedLast ? [...rs.slice(0, -1), rule, ...rs.slice(-1)] : [...rs, rule];
            });
          });
        }}
      >
        <Plus className="size-3" />
        Add rule
      </Button>

      {issues.length > 0 && (
        <ul className="mt-2 text-[11px] text-destructive">
          {issues.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={issues.length > 0}
          onClick={() => {
            setTested({ key, result: score(before, after) });
            setSaved(null);
          }}
        >
          Test on the routing test set
        </Button>
        <Button
          size="sm"
          disabled={!ready}
          onClick={() => {
            if (scope) onSaveProject(scope, rules);
            else onSave(current);
            setSaved("Saved.");
          }}
        >
          Save
        </Button>
      </div>
      {tested?.key === key && (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {tested.result
            ? `Picks the expected tier for ${pct(tested.result.after)} of standalone prompts (now ${pct(tested.result.before)}); ${String(tested.result.changed)} prompts change tier.`
            : "No routing test set to score against: import one below to check changes."}
        </p>
      )}
      {saved && (
        <p role="status" className="mt-1 text-[11px] text-muted-foreground">
          {saved}
        </p>
      )}
    </section>
  );
}
