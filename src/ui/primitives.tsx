import { Dialog, DropdownMenu, Tooltip } from "radix-ui";
import {
  Anchor,
  Archive,
  ArchiveRestore,
  Brain,
  Check,
  Folder,
  FolderMinus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Sparkles,
  Tag,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-lg bg-foreground text-background ${small ? "size-7" : "size-9"}`}
    >
      <Zap className={small ? "size-4" : "size-5"} fill="currentColor" strokeWidth={1.5} />
    </span>
  );
}
export function Hint({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-current/10 px-1 py-0.5 font-mono text-[10px] leading-none opacity-60">
      {children}
    </kbd>
  );
}
export function Tip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={200}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={7}
          className="z-50 max-w-80 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
        >
          {label}
          <Tooltip.Arrow className="fill-popover" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[3px]" />
        <Dialog.Content
          className={`fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-6 shadow-2xl ${wide ? "max-w-3xl" : "max-w-md"}`}
        >
          <div className="mb-5 pr-7">
            <Dialog.Title className="text-lg font-semibold tracking-tight">{title}</Dialog.Title>
            <Dialog.Description className="mt-1.5 text-sm text-muted-foreground">
              {description}
            </Dialog.Description>
          </div>
          <Dialog.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-5 right-5"
              aria-label="Close dialog (Esc)"
            >
              <X />
            </Button>
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function ThreadMenu({
  onRename,
  onDelete,
  projects,
  projectId,
  onMove,
  memoryOn,
  onToggleMemory,
  onSuggestMemories,
  pinned,
  archived,
  onTogglePin,
  onToggleArchive,
  onEditTags,
  stay,
}: {
  /** RT-06: keep Auto on one provider in this chat; `provider` is the one it would stay on. */
  stay?: { provider: "anthropic" | "openai" | null; on: boolean; onToggle: () => void };
  /** CH-02 */
  pinned: boolean;
  archived: boolean;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onEditTags: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** Saved memories are sent with this chat (PM-04). */
  memoryOn: boolean;
  onToggleMemory: () => void;
  /** Check this chat for things to remember now (PM-03). */
  onSuggestMemories: () => void;
  /** Projects this chat can move to (PM-01). */
  projects: { id: string; name: string }[];
  projectId: string | null;
  onMove: (projectId: string | null) => void;
}) {
  const item =
    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm outline-none focus:bg-accent";
  const targets = [...projects, ...(projectId ? [{ id: null, name: "No project" }] : [])].filter(
    (p) => p.id !== projectId,
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Conversation actions">
          <MoreHorizontal />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={5}
          className="z-30 max-h-[70dvh] min-w-48 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
        >
          <DropdownMenu.Item className={item} onSelect={onRename}>
            <Pencil className="size-3.5" />
            Rename chat
          </DropdownMenu.Item>
          {!archived && (
            <DropdownMenu.Item className={item} onSelect={onTogglePin}>
              {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              {pinned ? "Unpin" : "Pin to top"}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className={item} onSelect={onEditTags}>
            <Tag className="size-3.5" />
            Tags…
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={onToggleArchive}>
            {archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
            {archived ? "Unarchive" : "Archive"}
          </DropdownMenu.Item>
          <DropdownMenu.CheckboxItem className={item} checked={memoryOn} onSelect={onToggleMemory}>
            <Brain className="size-3.5" />
            Use memories in this chat
            <DropdownMenu.ItemIndicator className="ml-auto">
              <Check className="size-3.5" />
            </DropdownMenu.ItemIndicator>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Item className={item} onSelect={onSuggestMemories}>
            <Sparkles className="size-3.5" />
            Suggest memories now
          </DropdownMenu.Item>
          {stay?.provider && (
            <DropdownMenu.CheckboxItem className={item} checked={stay.on} onSelect={stay.onToggle}>
              <Anchor className="size-3.5" />
              Stay on {stay.provider === "anthropic" ? "Anthropic" : "OpenAI"}
              <DropdownMenu.ItemIndicator className="ml-auto">
                <Check className="size-3.5" />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.CheckboxItem>
          )}
          {targets.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Move to
              </DropdownMenu.Label>
              {targets.map((p) => (
                <DropdownMenu.Item
                  key={p.id ?? "none"}
                  className={item}
                  onSelect={() => {
                    onMove(p.id);
                  }}
                >
                  {p.id ? <Folder className="size-3.5" /> : <FolderMinus className="size-3.5" />}
                  <span className="truncate">{p.name}</span>
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}
          <DropdownMenu.Item className={`${item} text-destructive`} onSelect={onDelete}>
            <Trash2 className="size-3.5" />
            Delete chat
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
