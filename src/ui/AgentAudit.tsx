import { ScrollText } from "lucide-react";

export interface AuditRowView {
  id: string;
  when: string;
  project: string;
  model: string;
  /** "Ran pnpm test", "Edited src/a.ts". */
  action: string;
  /** "you", "always allowed", "needed nobody", "declined". */
  allowed: string;
  result: string;
  failed: boolean;
  runCost: string;
}

/**
 * Settings → Coding agent (AG-04): every tool call coding runs made, newest first, with how it
 * was allowed, what came back, the model and what its run cost.
 */
export function AgentAuditSection({ rows }: { rows: AuditRowView[] }) {
  return (
    <section className="mt-8 border-t pt-6" aria-label="Coding agent activity">
      <div className="mb-1 flex items-center gap-2">
        <ScrollText className="size-3.5 text-muted-foreground" />
        <h2 className="text-sm font-medium">Coding agent activity</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Every file read, change and command coding runs made, and who allowed it. Kept on this
        device.
      </p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No coding runs yet.</p>
      ) : (
        <div className="max-h-96 overflow-auto rounded-lg border">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-muted text-[10px] text-muted-foreground uppercase">
              <tr>
                <th className="px-2 py-1 font-medium">When</th>
                <th className="px-2 py-1 font-medium">What</th>
                <th className="px-2 py-1 font-medium">Allowed by</th>
                <th className="px-2 py-1 font-medium">Result</th>
                <th className="px-2 py-1 font-medium">Model · run cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{r.when}</td>
                  <td className="min-w-48 px-2 py-1">
                    <span className="font-mono break-all">{r.action}</span>
                    <span className="block text-[10px] text-muted-foreground">{r.project}</span>
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">{r.allowed}</td>
                  <td
                    className={`max-w-48 truncate px-2 py-1 font-mono ${r.failed ? "text-destructive" : ""}`}
                    title={r.result}
                  >
                    {r.result}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">
                    {r.model} · {r.runCost}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
