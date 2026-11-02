import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "./primitives";

/**
 * M10 step 18: the notice after a delete, while the rows are only marked. Undo brings them
 * back; Dismiss (or the end of the window) removes them for good.
 */
export function Undo({
  label,
  onUndo,
  onDismiss,
}: {
  label: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2"
    >
      <span>{label}</span>
      <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={onUndo}>
        Undo
        <Hint>Ctrl Z</Hint>
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}
