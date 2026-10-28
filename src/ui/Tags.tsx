import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "./primitives";

/** A chat's tags (CH-02), typed as words separated by commas or spaces. */
export function TagsDialog({
  open,
  tags,
  known,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  tags: string[];
  /** Tags used on other chats, offered with one click. */
  known: string[];
  onOpenChange: (open: boolean) => void;
  onSave: (tags: string[]) => void;
}) {
  const [text, setText] = useState(tags.join(", "));
  const words = text
    .split(/[,\s]+/)
    .map((w) => w.replace(/^#+/, "").toLowerCase())
    .filter(Boolean);
  const offered = known.filter((t) => !words.includes(t));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Tags"
      description="Filter the sidebar by tag, or search with #tag."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(words);
        }}
      >
        <Input
          aria-label="Tags"
          autoFocus
          placeholder="e.g. work, garden"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
        {offered.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {offered.map((t) => (
              <button
                key={t}
                type="button"
                className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                onClick={() => {
                  setText((v) => (v.trim() ? `${v.trim().replace(/,$/, "")}, ${t}` : t));
                }}
              >
                #{t}
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button size="sm" type="submit">
            Save tags
          </Button>
        </div>
      </form>
    </Modal>
  );
}
