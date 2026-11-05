import { useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Mic, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { speechPrice } from "@/cost/duration";
import { money } from "./format";
import { usePanelActive, usePanelLeave } from "./panelActivity";
import type { DictationConfig } from "@/dictation/useDictation";

function AudioConsent({
  open,
  onOpen,
  web,
  onAgree,
}: {
  open: boolean;
  onOpen: (open: boolean) => void;
  web: boolean;
  onAgree: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = usePanelActive();
  usePanelLeave(() => {
    onOpen(false);
  });
  return (
    <Dialog.Root open={open && active} onOpenChange={onOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-popover p-5 shadow-xl">
          <Dialog.Title className="text-sm font-medium">
            Send dictation audio to OpenAI?
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-xs leading-6 text-muted-foreground">
            {web
              ? "Your browser records audio, then sends it through trusted HULK to OpenAI."
              : "FUSE records your default microphone and sends the audio to OpenAI using your existing connection."}{" "}
            OpenAI&apos;s audio data policy applies. FUSE keeps raw audio only temporarily in
            memory, outside sync, exports and backups. Recordings stop at two minutes or 20 MiB.
            Transcription costs {money(speechPrice.micro_usd_per_minute)} per minute. The transcript
            is added to your editable draft; you choose when to send it. Incurred charges remain if
            you discard it.
          </Dialog.Description>
          <p className="mt-2 text-xs text-muted-foreground">
            Consent applies only here. Your OS or browser also controls microphone permission.
          </p>
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                setError(null);
                void onAgree()
                  .then(
                    () => {
                      onOpen(false);
                    },
                    (cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : "Couldn't save consent.");
                    },
                  )
                  .finally(() => {
                    setSaving(false);
                  });
              }}
            >
              {saving ? "Saving…" : "Agree to audio transfer"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DictationSettings({
  enabled,
  onChange,
  web,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void>;
  web: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="mt-8 border-t pt-6" aria-label="Dictation">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Mic className="size-4" /> Dictation
      </h2>
      <p className="mt-2 text-xs leading-6 text-muted-foreground">
        Use the composer microphone to hold and speak, or click to start and stop.
        {!web && " Also available after the quick-capture shortcut."} Text stays in your draft until
        you send it.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        OpenAI · {speechPrice.model} · {money(speechPrice.micro_usd_per_minute)}/min · two minutes /
        20 MiB maximum. No offline audio queue.
      </p>
      <Button
        className="mt-3"
        variant="outline"
        size="sm"
        data-settings-control="dictation-consent"
        aria-label={enabled ? "Turn off dictation" : "Set up dictation"}
        onClick={() => {
          if (!enabled) setOpen(true);
          else
            void onChange(false).catch((cause: unknown) => {
              setError(
                cause instanceof Error ? cause.message : "Couldn't record the policy change.",
              );
            });
        }}
      >
        {enabled ? "Turn off dictation" : "Set up dictation"}
      </Button>
      <p role="status" className="mt-2 text-xs text-muted-foreground">
        {error ??
          (enabled
            ? "Audio transfer enabled here. Microphone access is requested only when you start recording."
            : "Off. No audio is recorded or sent.")}
      </p>
      <AudioConsent open={open} onOpen={setOpen} web={web} onAgree={() => onChange(true)} />
    </section>
  );
}

export function DictationControls({
  config,
  phase,
  durationMs,
  estimateMicro,
  note,
  start,
  finish,
  cancel,
}: {
  config: DictationConfig;
  phase: "idle" | "starting" | "recording" | "transcribing";
  durationMs: number;
  estimateMicro: number;
  note: string | null;
  start: () => Promise<void>;
  finish: () => Promise<void>;
  cancel: () => void;
}) {
  const [consentOpen, setConsentOpen] = useState(false);
  const held = useRef<{ at: number } | null>(null);
  const suppressClick = useRef(false);
  const recording = phase === "recording";
  const busy = phase !== "idle";
  const toggle = () => {
    if (!config.consent) setConsentOpen(true);
    else if (recording) void finish();
    else if (!busy) void start();
  };
  const label = recording
    ? "Stop recording and transcribe"
    : phase === "starting"
      ? "Opening microphone…"
      : phase === "transcribing"
        ? "Transcribing…"
        : "Dictate";
  return (
    <>
      <div
        className="flex shrink-0 items-center gap-1"
        title={
          config.reason ??
          `${money(speechPrice.micro_usd_per_minute)}/min · click to start/stop, or hold to talk`
        }
      >
        <Button
          variant={recording ? "outline" : "ghost"}
          size="icon-sm"
          aria-label={label}
          aria-description={
            config.reason ??
            `${money(speechPrice.micro_usd_per_minute)} per minute. Click to start/stop, or hold to talk.`
          }
          disabled={Boolean(config.reason) || phase === "transcribing"}
          onPointerDown={(event) => {
            if (event.button !== 0 || !config.consent || config.reason || busy) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            held.current = { at: performance.now() };
            suppressClick.current = true;
            void start();
          }}
          onPointerUp={(event) => {
            const pointer = held.current;
            held.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            if (pointer && performance.now() - pointer.at >= 300) void finish();
          }}
          onLostPointerCapture={() => {
            if (held.current) {
              held.current = null;
              suppressClick.current = false;
              cancel();
            }
          }}
          onBlur={() => {
            if (held.current) {
              held.current = null;
              suppressClick.current = false;
              cancel();
            }
          }}
          onPointerCancel={() => {
            held.current = null;
            suppressClick.current = false;
            cancel();
          }}
          onClick={(event) => {
            // A pointer press started the operation already; a keyboard click is an accessible toggle.
            if (event.detail > 0 && suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            if (event.detail === 0) suppressClick.current = false;
            toggle();
          }}
        >
          {recording ? <Square className="size-3 fill-current" /> : <Mic className="size-4" />}
        </Button>
        {busy && (
          <Button variant="ghost" size="icon-sm" aria-label="Cancel dictation" onClick={cancel}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      <AudioConsent
        open={consentOpen}
        onOpen={setConsentOpen}
        web={config.web}
        onAgree={() => config.onConsent(true)}
      />
      <span className="sr-only" role="status">
        {note ??
          (busy
            ? `${label} ${String(Math.floor(durationMs / 1000))} seconds, estimated ${money(estimateMicro)}`
            : "")}
      </span>
    </>
  );
}
