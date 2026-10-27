import { CircleAlert, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UpdateState } from "@/app/useUpdate";

export function UpdateBar({
  update,
  onRestart,
  onDismiss,
}: {
  update: UpdateState;
  onRestart: () => void;
  onDismiss: () => void;
}) {
  if (update.kind === "none") return null;
  const failed = update.kind === "failed";
  return (
    <div
      role="status"
      aria-label="App update"
      className="flex items-center gap-2 border-b bg-muted/60 px-4 py-2 text-xs"
    >
      {failed ? (
        <CircleAlert className="size-3.5 text-destructive" />
      ) : (
        <Download className="size-3.5 text-muted-foreground" />
      )}
      <span className="flex-1">
        {failed
          ? `Update to FUSE ${update.version} failed: ${update.message}`
          : `FUSE ${update.version} is ready. Restart to update; your chats stay as they are.`}
      </span>
      <Button size="xs" onClick={onRestart} disabled={update.kind === "installing"}>
        {update.kind === "installing" ? "Restarting…" : failed ? "Try again" : "Restart now"}
      </Button>
      {update.kind !== "installing" && (
        <Button variant="ghost" size="icon-xs" aria-label="Later" onClick={onDismiss}>
          <X />
        </Button>
      )}
    </div>
  );
}
