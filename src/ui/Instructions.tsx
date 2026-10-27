import { Check, ScrollText } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { number } from "./format";
import { Modal, Tip } from "./primitives";
import type { GlobalInstructionsView, InstructionPartView } from "./types";

const textareaClass =
  "block min-h-24 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

function InstructionBox({
  label,
  hint,
  placeholder,
  value,
  maxChars,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  maxChars: number;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium">
          {label}
        </label>
        <span className="font-mono text-[10px] text-muted-foreground">
          {number(value.length)} / {number(maxChars)}
        </span>
      </div>
      <textarea
        id={id}
        className={textareaClass}
        placeholder={placeholder}
        value={value}
        maxLength={maxChars}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function SaveRow({ dirty, saved, onSave }: { dirty: boolean; saved: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center justify-end gap-3">
      {saved && !dirty && (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground" role="status">
          <Check className="size-3" />
          Saved
        </span>
      )}
      <Button size="sm" disabled={!dirty} onClick={onSave}>
        Save
      </Button>
    </div>
  );
}

/** Settings → Custom instructions: the global "about you" and "how to answer" boxes. */
export function GlobalInstructionsSection({
  value,
  maxChars,
  onSave,
}: {
  value: GlobalInstructionsView;
  maxChars: number;
  onSave: (value: GlobalInstructionsView) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  const dirty = draft.aboutYou !== value.aboutYou || draft.howToAnswer !== value.howToAnswer;
  return (
    <section className="mt-8 border-t pt-6" aria-label="Custom instructions">
      <div className="mb-1 flex items-center gap-2">
        <ScrollText className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Custom instructions</h2>
      </div>
      <p className="mb-4 text-[11px] text-muted-foreground">
        Sent with every message, on every model. Each chat can add its own from its header.
      </p>
      <div className="space-y-4">
        <InstructionBox
          label="About you"
          hint="What every model should know: your work, where you are, tools you use."
          placeholder="e.g. I'm a product designer in Toronto. I mostly work in Figma and Notion."
          value={draft.aboutYou}
          maxChars={maxChars}
          onChange={(aboutYou) => {
            setDraft((d) => ({ ...d, aboutYou }));
          }}
        />
        <InstructionBox
          label="How to answer"
          hint="Tone, length and format."
          placeholder="e.g. Lead with the answer. Keep it short. Use metric units."
          value={draft.howToAnswer}
          maxChars={maxChars}
          onChange={(howToAnswer) => {
            setDraft((d) => ({ ...d, howToAnswer }));
          }}
        />
        <SaveRow
          dirty={dirty}
          saved={saved}
          onSave={() => {
            onSave(draft);
            setSaved(true);
          }}
        />
      </div>
    </section>
  );
}

/** The header button: shows whether any instructions apply to this chat. */
export function InstructionsButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Tip label="Custom instructions for this chat">
      <Button
        variant="ghost"
        size="sm"
        className={`gap-1.5 text-[11px] ${count ? "" : "text-muted-foreground"}`}
        aria-label={`Instructions (${count ? `${String(count)} active` : "none"})`}
        onClick={onClick}
      >
        <ScrollText className="size-3.5" />
        {count ? `Instructions · ${String(count)}` : "Instructions"}
      </Button>
    </Tip>
  );
}

/** Everything that applies to this chat (CH-05), with this chat's own box editable. */
export function ThreadInstructionsDialog({
  open,
  onOpenChange,
  globalParts,
  thread,
  tokens,
  maxChars,
  onSave,
  onEditGlobal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  globalParts: InstructionPartView[];
  thread: string;
  /** Rough tokens all instructions add to every message, as saved. */
  tokens: number;
  maxChars: number;
  onSave: (text: string) => void;
  onEditGlobal: () => void;
}) {
  const [draft, setDraft] = useState(thread);
  const [saved, setSaved] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(thread);
          setSaved(false);
        }
        onOpenChange(next);
      }}
      title="Instructions for this chat"
      description="Sent with every message in this chat, on any model."
      wide
    >
      <div className="space-y-5">
        <section aria-label="Global instructions">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium">Also in effect</h3>
            <Button variant="link" size="xs" className="px-0" onClick={onEditGlobal}>
              Edit in Settings
            </Button>
          </div>
          {globalParts.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">None set.</p>
          ) : (
            <div className="space-y-2">
              {globalParts.map((p) => (
                <div key={p.label} className="rounded-lg bg-muted/60 px-3 py-2">
                  <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    {p.label}
                  </p>
                  <p className="mt-1 text-xs leading-5 whitespace-pre-wrap">{p.text}</p>
                </div>
              ))}
            </div>
          )}
        </section>
        <InstructionBox
          label="This chat only"
          hint="Takes priority over project and global instructions."
          placeholder="e.g. We're drafting a cover letter. Ask before rewriting whole paragraphs."
          value={draft}
          maxChars={maxChars}
          onChange={setDraft}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] text-muted-foreground">
            {tokens ? `~${number(tokens)} tokens added to every message` : "No instructions yet"}
          </span>
          <SaveRow
            dirty={draft.trim() !== thread}
            saved={saved}
            onSave={() => {
              onSave(draft);
              setSaved(true);
            }}
          />
        </div>
      </div>
    </Modal>
  );
}
