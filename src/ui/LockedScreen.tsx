import { LockKeyhole } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Shown when the database is encrypted and the keychain has no key, or the wrong one. */
export function LockedScreen({ onUnlock }: { onUnlock: (key: string) => Promise<boolean> }) {
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "trying" | "wrong" | "error">("idle");
  const id = useId();
  return (
    <main className="flex h-dvh items-center justify-center bg-background px-4 text-foreground">
      <form
        className="w-full max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          setState("trying");
          onUnlock(key).then(
            (ok) => {
              setState(ok ? "idle" : "wrong");
            },
            () => {
              setState("error");
            },
          );
        }}
      >
        <LockKeyhole className="mb-4 size-6 text-muted-foreground" />
        <h1 className="text-xl font-semibold tracking-tight">Your chats are locked</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          They&apos;re encrypted, and this computer&apos;s keychain doesn&apos;t have the key. Enter
          the recovery key you saved from Settings.
        </p>
        <label htmlFor={id} className="mt-6 mb-1.5 block text-xs font-medium">
          Recovery key
        </label>
        <Input
          id={id}
          autoFocus
          className="font-mono"
          placeholder="XXXXXXXX-XXXXXXXX-…"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            if (state !== "trying") setState("idle");
          }}
        />
        {state === "wrong" && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            That key doesn&apos;t open these chats. Check it and try again.
          </p>
        )}
        {state === "error" && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            Something went wrong opening the database. Try again.
          </p>
        )}
        <Button type="submit" className="mt-4 w-full" disabled={!key.trim() || state === "trying"}>
          {state === "trying" ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
    </main>
  );
}
