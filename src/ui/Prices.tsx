import { LoaderCircle, Pencil, RotateCcw, Tags } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface PriceRowView {
  key: string;
  name: string;
  /** US dollars per 1M tokens. */
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  verifiedOn: string;
  edited: boolean;
}

export interface PriceCheckView {
  version: string;
  changes: { name: string; change: string }[];
}

type Fields = Record<"input" | "output" | "cachedInput" | "cacheWrite", string>;

const FIELDS: { key: keyof Fields; label: string }[] = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cachedInput", label: "Cached input" },
  { key: "cacheWrite", label: "Cache write" },
];

const usd = (n: number | undefined) => (n === undefined ? "—" : `$${String(n)}`);

/** Settings → Prices (MM-04): every model's price, editable, and a refresh from the repo. */
export function PricesSection({
  rows,
  version,
  oldestDays,
  staleDays,
  onSave,
  onCheck,
  onApply,
}: {
  rows: PriceRowView[];
  version: string;
  oldestDays: number;
  staleDays: number;
  /** Saves your price for a model; null goes back to the list's price. */
  onSave: (key: string, price: Record<keyof Fields, number | undefined> | null) => void;
  /** Fetches the repo's price list and says what it would change. */
  onCheck: () => Promise<PriceCheckView>;
  /** Uses the list from the last check. */
  onApply: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>({
    input: "",
    output: "",
    cachedInput: "",
    cacheWrite: "",
  });
  const [check, setCheck] = useState<PriceCheckView | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const parsed = Object.fromEntries(
    FIELDS.map((f) => {
      const v = fields[f.key].trim();
      return [f.key, v === "" ? undefined : Number(v)];
    }),
  ) as Record<keyof Fields, number | undefined>;
  const valid =
    parsed.input !== undefined &&
    parsed.output !== undefined &&
    Object.values(parsed).every((v) => v === undefined || (Number.isFinite(v) && v >= 0));
  const fail = (err: unknown) => {
    setBusy(false);
    setStatus(err instanceof Error ? err.message : String(err));
  };
  return (
    <section className="mt-8 border-t pt-6" aria-label="Prices">
      <div className="mb-1 flex items-center gap-2">
        <Tags className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Prices</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        US dollars per million tokens, used for every cost FUSE shows. Price list {version}; the
        oldest price was checked {oldestDays} days ago.
        {oldestDays > staleDays && " Prices change often, so check for new ones."}
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setStatus(null);
            setCheck(null);
            onCheck().then((c) => {
              setBusy(false);
              if (c.changes.length === 0) setStatus(`Prices are up to date (${c.version}).`);
              else setCheck(c);
            }, fail);
          }}
        >
          {busy && <LoaderCircle className="size-3 animate-spin" />}
          Check for new prices
        </Button>
      </div>
      {check && (
        <div className="mt-3 rounded-lg border p-3 text-xs" aria-label="New prices">
          <p className="mb-1.5 font-medium">Price list {check.version} changes:</p>
          <ul className="space-y-0.5">
            {check.changes.map((c) => (
              <li key={`${c.name}-${c.change}`}>
                {c.name}: <span className="text-muted-foreground">{c.change}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Prices you edited yourself stay as they are.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onApply().then(() => {
                  setBusy(false);
                  setCheck(null);
                  setStatus(`Now using price list ${check.version}.`);
                }, fail);
              }}
            >
              Use these prices
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCheck(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {status && (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {status}
        </p>
      )}
      <table className="mt-4 w-full text-left text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Model</th>
            {FIELDS.map((f) => (
              <th key={f.key} className="py-1 text-right font-normal">
                {f.label}
              </th>
            ))}
            <th className="py-1 text-right font-normal">Checked</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            editing === r.key ? (
              <tr key={r.key} className="border-t">
                <td className="py-1.5">{r.name}</td>
                {FIELDS.map((f) => (
                  <td key={f.key} className="px-0.5 py-1.5">
                    <Input
                      aria-label={`${r.name} ${f.label.toLowerCase()} price`}
                      inputMode="decimal"
                      className="h-7 text-right text-[11px]"
                      value={fields[f.key]}
                      onChange={(e) => {
                        setFields((v) => ({ ...v, [f.key]: e.target.value }));
                      }}
                    />
                  </td>
                ))}
                <td colSpan={2} className="py-1.5 text-right whitespace-nowrap">
                  <Button
                    size="sm"
                    disabled={!valid}
                    onClick={() => {
                      onSave(r.key, parsed);
                      setEditing(null);
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </Button>
                </td>
              </tr>
            ) : (
              <tr key={r.key} className="border-t">
                <td className="py-1.5">
                  {r.name}
                  {r.edited && <span className="ml-1 text-muted-foreground">(yours)</span>}
                </td>
                <td className="py-1.5 text-right font-mono">{usd(r.input)}</td>
                <td className="py-1.5 text-right font-mono">{usd(r.output)}</td>
                <td className="py-1.5 text-right font-mono">{usd(r.cachedInput)}</td>
                <td className="py-1.5 text-right font-mono">{usd(r.cacheWrite)}</td>
                <td className="py-1.5 text-right font-mono text-muted-foreground">
                  {r.verifiedOn}
                </td>
                <td className="py-1.5 text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Edit ${r.name} price`}
                    onClick={() => {
                      setEditing(r.key);
                      setFields({
                        input: String(r.input),
                        output: String(r.output),
                        cachedInput: r.cachedInput === undefined ? "" : String(r.cachedInput),
                        cacheWrite: r.cacheWrite === undefined ? "" : String(r.cacheWrite),
                      });
                    }}
                  >
                    <Pencil className="size-3" />
                  </Button>
                  {r.edited && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Use the list's ${r.name} price`}
                      onClick={() => {
                        onSave(r.key, null);
                      }}
                    >
                      <RotateCcw className="size-3" />
                    </Button>
                  )}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </section>
  );
}
