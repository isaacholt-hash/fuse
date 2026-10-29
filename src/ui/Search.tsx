import { FileCode, MessageSquare, Paperclip, Search as SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { Modal } from "./primitives";

export interface SearchHitView {
  key: string;
  threadId: string;
  threadTitle: string;
  messageId: string | null;
  /** "You", "Answer" or "Title" */
  kind: string;
  /** Text with matches between \u0001 and \u0002. */
  snippet: string;
  date: string;
  /** AR-06: an artifact rather than a message; opens in the side panel. */
  artifactKey?: string;
}

const SEARCH_DELAY_MS = 150;
// The match markers searchChats puts around hits (src/storage/search.ts).
const MARK_START = "\u0001";
const MARK_END = "\u0002";

/** Splits a snippet at the match markers into plain and highlighted runs. */
function Highlighted({ text }: { text: string }) {
  // Runs alternate plain / marked: "a\u0001b\u0002c" → a, b (marked), c.
  const runs: { text: string; marked: boolean }[] = [];
  let rest = text;
  while (rest) {
    const start = rest.indexOf(MARK_START);
    const end = start < 0 ? -1 : rest.indexOf(MARK_END, start);
    if (start < 0 || end < 0) {
      runs.push({ text: rest, marked: false });
      break;
    }
    if (start > 0) runs.push({ text: rest.slice(0, start), marked: false });
    runs.push({ text: rest.slice(start + 1, end), marked: true });
    rest = rest.slice(end + 1);
  }
  return (
    <>
      {runs.map((r, i) =>
        r.marked ? (
          <mark
            key={i}
            className="rounded-sm bg-amber-200/70 px-0.5 text-foreground dark:bg-amber-500/30"
          >
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}

/** Search across every chat (CH-02); picking a result opens the chat at that message. */
export function SearchDialog({
  open,
  onOpenChange,
  onSearch,
  onOpen,
  onAttach,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSearch: (text: string) => Promise<SearchHitView[]>;
  onOpen: (hit: SearchHitView) => void;
  /** AR-06: attaches an artifact to the chat on screen as context. */
  onAttach?: (hit: SearchHitView) => void;
}) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchHitView[] | null>(null);
  useEffect(() => {
    if (!text.trim()) return;
    let current = true;
    const timer = setTimeout(() => {
      onSearch(text).then(
        (found) => {
          if (current) setHits(found);
        },
        () => {
          if (current) setHits([]);
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [text, onSearch]);
  const shown = text.trim() ? hits : null;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setText("");
          setHits(null);
        }
        onOpenChange(next);
      }}
      title="Search chats"
      description="Every question and answer, across all your chats."
      wide
    >
      <div className="flex items-center gap-2.5 rounded-lg border px-3 py-2">
        <SearchIcon className="size-4 text-muted-foreground" />
        <input
          aria-label="Search chats"
          autoFocus
          placeholder="Search…"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            const first = shown?.[0];
            if (e.key === "Enter" && first) onOpen(first);
          }}
        />
      </div>
      <div className="mt-3 max-h-[55dvh] overflow-y-auto" role="list" aria-label="Search results">
        {shown?.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">Nothing found.</p>
        )}
        {shown?.map((hit) => {
          const row = (
            <button
              key={hit.key}
              {...(hit.artifactKey ? {} : { role: "listitem" })}
              className="flex w-full min-w-0 flex-1 gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent focus-visible:bg-accent"
              onClick={() => {
                onOpen(hit);
              }}
            >
              {hit.artifactKey ? (
                <FileCode className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-xs font-medium">
                  <span className="truncate">{hit.threadTitle}</span>
                  <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                    {hit.kind} · {hit.date}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
                  <Highlighted text={hit.snippet} />
                </span>
              </span>
            </button>
          );
          // An artifact also offers Attach, so it gets a row of its own around the button.
          return hit.artifactKey ? (
            <div key={hit.key} role="listitem" className="flex items-start gap-1">
              {row}
              {onAttach && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1.5 shrink-0 text-xs"
                  aria-label={`Attach ${hit.threadTitle} to this chat`}
                  onClick={() => {
                    onAttach(hit);
                  }}
                >
                  <Paperclip className="size-3" />
                  Attach
                </Button>
              )}
            </div>
          ) : (
            row
          );
        })}
      </div>
    </Modal>
  );
}
