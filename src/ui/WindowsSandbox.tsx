import { useState } from "react";
import { Box } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Greyed } from "./primitives";
import { WEB_REASONS } from "./webReasons";

/**
 * Settings → Sandbox on Windows (M8 step 9, WF-07): on unless switched off. On, commands from Code and Work runs run in an AppContainer that can write only in
 * the chat's folders. Reset puts those folders' permissions back as they were.
 */
export function WindowsSandboxSection({
  on,
  onToggle,
  onReset,
  web = false,
}: {
  /** PL-02: the web app on HULK, where this switch doesn't apply: shown, greyed, with the reason. */
  web?: boolean;
  on: boolean;
  onToggle: (on: boolean) => void;
  /** Resolves to what to say: how many folders were put back, or what failed. */
  onReset: () => Promise<string>;
}) {
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="mt-8 border-t pt-6" aria-label="Sandbox on Windows">
      <div className="mb-1 flex items-center gap-2">
        <Box className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Sandbox on Windows</h2>
      </div>
      <div className="space-y-2 text-[11px] leading-5 text-muted-foreground">
        <p>
          When this is on, commands run in a Windows sandbox. They can write only in the chat&apos;s
          folders, and they have no network unless you allow it. While it&apos;s off, commands run
          with your full rights. Turn it off only if a tool you need can&apos;t run in it (programs
          installed under your user folder, or ones that reach localhost).
        </p>
        <p>
          To let the sandbox write in a folder, FUSE adds an entry to that folder&apos;s permissions
          the first time a command runs there. That can take a while on a large folder. The entry
          stays until you reset.
        </p>
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={on}
          disabled={web}
          onChange={(e) => {
            onToggle(e.target.checked);
          }}
        />
        Run commands in the sandbox
      </label>
      {web && <Greyed>{WEB_REASONS.windowsSandbox}</Greyed>}
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          disabled={busy || web}
          onClick={() => {
            setBusy(true);
            setSaid(null);
            void onReset()
              .then(setSaid)
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          Reset folder permissions
        </Button>
        {said && (
          <p role="status" className="text-[11px] text-muted-foreground">
            {said}
          </p>
        )}
      </div>
    </section>
  );
}
