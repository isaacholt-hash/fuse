import { Keyboard } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Greyed } from "./primitives";
import { WEB_REASONS } from "./webReasons";

/** Settings → Quick capture (CH-08, PL-07). */
export function QuickCaptureSection({
  shortcut,
  mayNotWork,
  error,
  onSave,
  web = false,
}: {
  /** The active shortcut, or null when it's off. */
  shortcut: string | null;
  mayNotWork: boolean;
  error: string | null;
  onSave: (shortcut: string | null) => void;
  /** PL-02: the web app on HULK, which has no global shortcut: shown, greyed, with the reason. */
  web?: boolean;
}) {
  const [draft, setDraft] = useState(shortcut ?? "");
  return (
    <section className="mt-8 border-t pt-6" aria-label="Quick capture">
      <div className="mb-1 flex items-center gap-2">
        <Keyboard className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Quick capture</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-muted-foreground">
        A shortcut that works from any app: it brings FUSE forward on a new chat, ready to type.
        Write it like Ctrl+Alt+Space or Super+J.
      </p>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!web) onSave(draft.trim() || null);
        }}
      >
        <Input
          aria-label="Quick capture shortcut"
          className="h-8 w-48 text-xs"
          value={draft}
          placeholder="Off"
          disabled={web}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
        />
        <Button type="submit" size="sm" variant="outline" disabled={web}>
          Save
        </Button>
        {shortcut && !web && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft("");
              onSave(null);
            }}
          >
            Turn off
          </Button>
        )}
      </form>
      {web ? (
        <Greyed>{WEB_REASONS.hotkey}</Greyed>
      ) : (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {error ?? (shortcut ? `On: ${shortcut}` : "Off")}
        </p>
      )}
      {mayNotWork && shortcut && !web && (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
          This desktop runs Wayland, which may not pass global shortcuts to apps. If it doesn&apos;t
          work, set one in your desktop&apos;s keyboard settings that opens FUSE.
        </p>
      )}
    </section>
  );
}
