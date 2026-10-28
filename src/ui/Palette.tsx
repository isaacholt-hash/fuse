import { Command, CornerDownLeft, MessageSquare, Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { useMemo, useState } from "react";
import { fuzzyScore } from "./fuzzy";
import { Hint } from "./primitives";

export interface PaletteItem {
  id: string;
  label: string;
  /** e.g. "Chats" or "Actions" */
  group: string;
  /** Keyboard shortcut shown on the right, e.g. "Ctrl N". */
  shortcut?: string;
  run: () => void;
}

/** The command palette (CH-08): every action and recent chats, by typing. */
export function CommandPalette({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PaletteItem[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const shown = useMemo(
    () =>
      items
        .map((item, i) => ({ item, i, score: fuzzyScore(query, `${item.group}: ${item.label}`) }))
        .filter((x): x is { item: PaletteItem; i: number; score: number } => x.score !== null)
        .sort((a, b) => (query ? b.score - a.score : 0) || a.i - b.i)
        .slice(0, 50)
        .map((x) => x.item),
    [items, query],
  );
  const close = () => {
    setQuery("");
    setActive(0);
    onOpenChange(false);
  };
  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    item.run();
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed top-[14vh] left-1/2 z-50 w-[560px] max-w-[calc(100%-2rem)] -translate-x-1/2 overflow-hidden rounded-2xl border bg-background shadow-2xl"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b px-4 py-3">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              aria-label="Type a command or a chat"
              placeholder="Type a command or a chat…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, shown.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  run(shown[active]);
                }
              }}
            />
            <Hint>Esc</Hint>
          </div>
          <ul className="max-h-[55dvh] overflow-y-auto p-2" role="listbox" aria-label="Commands">
            {shown.map((item, i) => (
              <li key={item.id} role="option" aria-selected={i === active}>
                <button
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] ${i === active ? "bg-accent" : "hover:bg-accent/60"}`}
                  onMouseEnter={() => {
                    setActive(i);
                  }}
                  onClick={() => {
                    run(item);
                  }}
                >
                  {item.group === "Chats" ? (
                    <MessageSquare className="size-3.5 text-muted-foreground" />
                  ) : (
                    <Command className="size-3.5 text-muted-foreground" />
                  )}
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className="text-[10px] text-muted-foreground">{item.group}</span>
                  {item.shortcut && <Hint>{item.shortcut}</Hint>}
                  {i === active && <CornerDownLeft className="size-3 text-muted-foreground" />}
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="p-6 text-center text-sm text-muted-foreground">Nothing matches.</li>
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
