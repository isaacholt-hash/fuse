import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RepoInfo } from "@/repo/api";
import { Modal } from "./primitives";

/**
 * The web app's folder picker (M10 step 5): there's no native dialog in a browser, so you type a
 * folder on HULK. The server checks it (`repo_check`): it must exist and be under the server
 * user's home. `onDone` gets the folder, or null when cancelled.
 */
export function WebFolderDialog({
  open,
  check,
  onDone,
}: {
  open: boolean;
  check: (path: string) => Promise<RepoInfo>;
  onDone: (info: RepoInfo | null) => void;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const close = (info: RepoInfo | null) => {
    setPath("");
    setError(null);
    setBusy(false);
    onDone(info);
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) close(null);
      }}
      title="Add a folder"
      description="A folder on HULK, e.g. /home/daywalker/projects/x"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const wanted = path.trim();
          if (!wanted || busy) return;
          setBusy(true);
          setError(null);
          check(wanted).then(close, (err: unknown) => {
            setBusy(false);
            setError(err instanceof Error ? err.message : String(err));
          });
        }}
      >
        <label htmlFor={id} className="mb-1.5 block text-xs font-medium">
          Folder on HULK
        </label>
        <Input
          id={id}
          autoFocus
          className="font-mono text-xs"
          spellCheck={false}
          placeholder="/home/daywalker/projects/x"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              close(null);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!path.trim() || busy}>
            {busy ? "Checking…" : "Use this folder"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
