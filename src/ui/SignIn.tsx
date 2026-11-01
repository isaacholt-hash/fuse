import { KeyRound } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The web app's front door on HULK (M10 step 5), in the locked screen's style: choose the
 * passphrase on the first visit ("setUp"), or sign in with it. `onSubmit` resolves to the
 * server's words when it says no (a wrong passphrase, a pause after too many), or null.
 */
export function SignInScreen({
  mode,
  minLength,
  onSubmit,
}: {
  mode: "setUp" | "signIn";
  minLength: number;
  onSubmit: (passphrase: string) => Promise<string | null>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { pass: useId(), again: useId() };
  const setUp = mode === "setUp";
  const short = setUp && passphrase.length > 0 && passphrase.length < minLength;
  const mismatch = setUp && again.length > 0 && again !== passphrase;
  const ready = setUp
    ? passphrase.length >= minLength && again === passphrase
    : passphrase.length > 0;
  return (
    <main className="flex h-dvh items-center justify-center bg-background px-4 text-foreground">
      <form
        className="w-full max-w-md"
        aria-label={setUp ? "Choose a passphrase" : "Sign in"}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) return;
          setBusy(true);
          setError(null);
          onSubmit(passphrase).then(
            (said) => {
              setBusy(false);
              setError(said);
              if (said) setPassphrase("");
            },
            (e: unknown) => {
              setBusy(false);
              setError(e instanceof Error ? e.message : String(e));
            },
          );
        }}
      >
        <KeyRound className="mb-4 size-6 text-muted-foreground" />
        <h1 className="text-xl font-semibold tracking-tight">
          {setUp ? "Choose a passphrase" : "Sign in to FUSE on HULK"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {setUp
            ? `This is the first visit. Pick a passphrase of at least ${String(minLength)} characters: it's the only way into FUSE on HULK, so keep it in your password manager.`
            : "Enter the passphrase you chose for FUSE on HULK."}
        </p>
        <label htmlFor={ids.pass} className="mt-6 mb-1.5 block text-xs font-medium">
          Passphrase
        </label>
        <Input
          id={ids.pass}
          type="password"
          autoFocus
          autoComplete={setUp ? "new-password" : "current-password"}
          value={passphrase}
          onChange={(e) => {
            setPassphrase(e.target.value);
            setError(null);
          }}
        />
        {short && (
          <p className="mt-2 text-xs text-muted-foreground">
            At least {minLength} characters ({passphrase.length} so far).
          </p>
        )}
        {setUp && (
          <>
            <label htmlFor={ids.again} className="mt-4 mb-1.5 block text-xs font-medium">
              Passphrase again
            </label>
            <Input
              id={ids.again}
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(e) => {
                setAgain(e.target.value);
                setError(null);
              }}
            />
            {mismatch && <p className="mt-2 text-xs text-destructive">The two don&apos;t match.</p>}
          </>
        )}
        {error && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" className="mt-4 w-full" disabled={!ready || busy}>
          {busy ? (setUp ? "Setting up…" : "Signing in…") : setUp ? "Set passphrase" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
