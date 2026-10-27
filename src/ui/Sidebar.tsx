import { money } from "./format";
import {
  Check,
  ChevronDown,
  MessageSquare,
  PanelLeftClose,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Hint, Mark, Tip } from "./primitives";
import type { ThreadView } from "./types";

interface Props {
  threads: ThreadView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onCollapse: () => void;
  onSettings: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (thread: ThreadView) => void;
}
export function Sidebar({
  threads,
  selectedId,
  onSelect,
  onNew,
  onCollapse,
  onSettings,
  onRename,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const save = () => {
    if (editingId && title.trim()) onRename(editingId, title.trim());
    setEditingId(null);
  };
  return (
    <aside
      className="flex h-full w-[248px] shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground max-[800px]:w-[218px]"
      aria-label="Chat sidebar"
    >
      <div className="flex h-[76px] shrink-0 items-center gap-2.5 px-5">
        <Mark small />
        <span className="text-lg font-semibold tracking-[0.12em]">FUSE</span>
        <Tip label="Collapse sidebar · Ctrl+B">
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-muted-foreground"
            aria-label="Collapse sidebar (Ctrl+B)"
            onClick={onCollapse}
          >
            <PanelLeftClose />
          </Button>
        </Tip>
      </div>
      <div className="px-4 pb-5">
        <Button
          variant="outline"
          className="h-10 w-full justify-start gap-2.5 bg-background shadow-xs"
          onClick={onNew}
        >
          <Plus className="size-4" />
          New chat
          <span className="ml-auto">
            <Hint>Ctrl N</Hint>
          </span>
        </Button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-5" aria-label="Conversations">
        {threads.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            <MessageSquare className="mx-auto mb-3 size-5" />
            No chats yet
          </div>
        )}
        {(["Today", "Yesterday", "Previous 7 days", "Older"] as const).map((group) => {
          const rows = threads.filter((thread) => thread.group === group);
          return (
            rows.length > 0 && (
              <section key={group} className="mb-5">
                <h2 className="mb-2 px-3 text-[10px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
                  {group}
                </h2>
                <div className="space-y-1">
                  {rows.map((thread) => (
                    <div
                      key={thread.id}
                      className={`group relative rounded-lg ${selectedId === thread.id ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"}`}
                    >
                      {editingId === thread.id ? (
                        <form
                          className="flex h-[54px] items-center gap-1 px-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            save();
                          }}
                        >
                          <input
                            aria-label="Chat name"
                            autoFocus
                            className="w-full min-w-0 rounded border bg-background p-1.5 text-xs"
                            value={title}
                            onChange={(e) => {
                              setTitle(e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") setEditingId(null);
                            }}
                          />
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            type="submit"
                            aria-label="Save chat name"
                          >
                            <Check />
                          </Button>
                        </form>
                      ) : (
                        <>
                          <button
                            className="w-full rounded-lg px-3 py-2.5 text-left outline-offset-2"
                            aria-current={selectedId === thread.id ? "page" : undefined}
                            onClick={() => {
                              onSelect(thread.id);
                            }}
                          >
                            <span className="block truncate pr-1 text-[12px] font-medium">
                              {thread.title}
                            </span>
                            <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                              {money(thread.costMicro)}
                            </span>
                          </button>
                          <div className="absolute right-2 bottom-1.5 flex gap-0.5 rounded bg-sidebar-accent opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Rename ${thread.title}`}
                              onClick={() => {
                                setEditingId(thread.id);
                                setTitle(thread.title);
                              }}
                            >
                              <Pencil className="size-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Delete ${thread.title}`}
                              onClick={() => {
                                onDelete(thread);
                              }}
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )
          );
        })}
      </nav>
      <div className="mx-4 border-t py-3">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2.5 text-xs text-muted-foreground"
          onClick={onSettings}
        >
          <Settings className="size-4" />
          Settings
          <span className="ml-auto">
            <Hint>Ctrl ,</Hint>
          </span>
        </Button>
      </div>
      <div className="flex items-center gap-2.5 border-t px-5 py-4">
        <span className="flex size-7 items-center justify-center rounded-full border bg-background text-[10px] font-semibold">
          IH
        </span>
        <div className="flex-1">
          <p className="text-xs font-medium">Isaac’s workspace</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Local · Personal</p>
        </div>
        <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
      </div>
    </aside>
  );
}
