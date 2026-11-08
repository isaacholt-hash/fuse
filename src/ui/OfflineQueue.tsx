import { Clock, Pencil, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export interface QueuedView {
  id: string;
  text: string;
  state: "queued" | "dispatching" | "blocked" | "unknown";
  reason: string | null;
}

/** Another chat with messages waiting to send, for the reconnect notice. */
export interface OtherQueue {
  threadId: string;
  title: string;
  count: number;
}

const STATE: Record<QueuedView["state"], string> = {
  queued: "Waiting",
  dispatching: "Sending…",
  blocked: "Needs you",
  unknown: "May have been sent",
};

/** M18.1: this chat's queued messages, with Edit and Cancel while they wait (PL-05). */
export function QueuedMessages({
  items,
  onEdit,
  onCancel,
  onSendNow,
  others = [],
  onOpen,
  online = false,
}: {
  items: QueuedView[];
  onEdit: (id: string, text: string) => void;
  onCancel: (id: string) => void;
  /** M18.2: the owner's renewed approval for a held or uncertain message. */
  onSendNow?: (id: string) => void;
  /** M18.2: other chats with waiting messages; they send when opened. */
  others?: OtherQueue[];
  onOpen?: (threadId: string) => void;
  online?: boolean;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  if (items.length === 0 && others.length === 0) return null;
  return (
    <section
      aria-label="Queued messages"
      className="mb-2 rounded-lg border border-dashed px-3 py-2 text-[12px]"
    >
      {items.length > 0 && (
        <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
          <Clock className="size-3" />
          {online
            ? `Queued (${String(items.length)}) · back online: sending in order, with today's checks`
            : `Queued (${String(items.length)}) · sends from this desktop, in order, when you're back online`}
        </h3>
      )}
      <ol className="flex flex-col gap-1.5">
        {items.map((q) =>
          editing?.id === q.id ? (
            <li key={q.id}>
              <form
                aria-label="Edit queued message"
                className="flex flex-col gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!editing.text.trim()) return;
                  onEdit(q.id, editing.text);
                  setEditing(null);
                }}
              >
                <textarea
                  aria-label="Queued message text"
                  className="min-h-16 rounded-md border border-input bg-background p-2 text-[12px] outline-none focus:border-ring"
                  value={editing.text}
                  onChange={(e) => {
                    setEditing({ id: q.id, text: e.target.value });
                  }}
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" className="h-7 text-[12px]">
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[12px]"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </li>
          ) : (
            <li key={q.id} className="flex items-start gap-2" aria-label={`Queued: ${q.text}`}>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 whitespace-pre-wrap">{q.text}</span>
                <span className="block text-[12px] text-muted-foreground">
                  {STATE[q.state]}
                  {q.reason ? ` · ${q.reason}` : ""}
                </span>
              </span>
              {(q.state === "blocked" || q.state === "unknown") && onSendNow && online && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[12px]"
                  onClick={() => {
                    onSendNow(q.id);
                  }}
                >
                  Send now
                </Button>
              )}
              {q.state === "queued" && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Edit queued message"
                  onClick={() => {
                    setEditing({ id: q.id, text: q.text });
                  }}
                >
                  <Pencil />
                </Button>
              )}
              {q.state !== "dispatching" && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Cancel queued message"
                  onClick={() => {
                    onCancel(q.id);
                  }}
                >
                  <X />
                </Button>
              )}
            </li>
          ),
        )}
      </ol>
      {others.length > 0 && (
        <p className="mt-1.5 text-[12px] text-muted-foreground" role="status">
          Also waiting:{" "}
          {others.map((o, i) => (
            <span key={o.threadId}>
              {i > 0 ? ", " : ""}
              <button
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => onOpen?.(o.threadId)}
              >
                {o.title} ({o.count})
              </button>
            </span>
          ))}
          {online ? ". Each sends when you open its chat." : "."}
        </p>
      )}
    </section>
  );
}
