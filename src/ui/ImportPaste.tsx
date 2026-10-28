import { useState } from "react";
import { Button } from "@/components/ui/button";

export type PasteKind = "memories" | "aboutYou" | "howToAnswer";

const KINDS: { id: PasteKind; label: string; placeholder: string }[] = [
  {
    id: "memories",
    label: "Memories",
    placeholder:
      "Paste ChatGPT's saved memories (Settings → Personalization → Manage memories) or Claude's memory.",
  },
  {
    id: "aboutYou",
    label: "About you",
    placeholder: "Paste your custom instructions: what the app should know about you.",
  },
  {
    id: "howToAnswer",
    label: "How to answer",
    placeholder: "Paste your custom instructions: how you'd like answers written.",
  },
];

/**
 * Settings → Import, pasted text (PM-08): memories become suggestions for the usual review;
 * custom instructions fill a global box after a confirm, added below what's there.
 */
export function ImportPaste({
  onMemories,
  onInstructions,
  current,
}: {
  /** Adds the facts as suggestions; returns a sentence saying what happened. */
  onMemories: (text: string) => Promise<string>;
  onInstructions: (box: "aboutYou" | "howToAnswer", text: string) => Promise<void>;
  /** What the global boxes hold now, to warn before adding to them. */
  current: { aboutYou: string; howToAnswer: string };
}) {
  const [kind, setKind] = useState<PasteKind>("memories");
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const spec = KINDS.find((k) => k.id === kind) ?? { id: kind, label: kind, placeholder: "" };
  const done = (message: string) => {
    setBusy(false);
    setConfirming(false);
    setStatus(message);
  };
  const fail = (err: unknown) => {
    done(err instanceof Error ? err.message : String(err));
  };
  const run = () => {
    setBusy(true);
    if (kind === "memories") {
      onMemories(text).then((message) => {
        setText("");
        done(message);
      }, fail);
      return;
    }
    onInstructions(kind, text).then(() => {
      setText("");
      done(`Added to "${spec.label}". You can edit it under Instructions.`);
    }, fail);
  };
  return (
    <div className="mt-5" aria-label="Paste memories or instructions">
      <h3 className="mb-1 text-xs font-medium">Memories and custom instructions</h3>
      <div className="mb-2 flex gap-1" role="radiogroup" aria-label="What you're pasting">
        {KINDS.map((k) => (
          <Button
            key={k.id}
            size="sm"
            variant={k.id === kind ? "secondary" : "ghost"}
            role="radio"
            aria-checked={k.id === kind}
            onClick={() => {
              setKind(k.id);
              setConfirming(false);
              setStatus(null);
            }}
          >
            {k.label}
          </Button>
        ))}
      </div>
      <textarea
        aria-label="Pasted text"
        rows={5}
        placeholder={spec.placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setConfirming(false);
        }}
        className="w-full resize-y rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {confirming && kind !== "memories" ? (
        <div className="mt-2 rounded-lg border p-3 text-xs" role="alert">
          <p>
            {current[kind].trim()
              ? `"${spec.label}" already has text. The pasted text goes below it.`
              : `This fills "${spec.label}", used in every chat.`}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy} onClick={run}>
              Add to {spec.label}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          className="mt-2"
          disabled={busy || !text.trim()}
          onClick={() => {
            setStatus(null);
            if (kind === "memories") run();
            else setConfirming(true);
          }}
        >
          {kind === "memories" ? "Suggest these memories" : `Use as "${spec.label}"…`}
        </Button>
      )}
      {status && (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {status}
        </p>
      )}
    </div>
  );
}
