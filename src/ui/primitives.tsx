import { Dialog, DropdownMenu, Tooltip } from "radix-ui";
import { MoreHorizontal, Pencil, Trash2, X, Zap } from "lucide-react";
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
export function ThreadMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  const item =
    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm outline-none focus:bg-accent";
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
          className="z-30 min-w-44 rounded-lg border bg-popover p-1 shadow-lg"
        >
          <DropdownMenu.Item className={item} onSelect={onRename}>
            <Pencil className="size-3.5" />
            Rename chat
          </DropdownMenu.Item>
          <DropdownMenu.Item className={`${item} text-destructive`} onSelect={onDelete}>
            <Trash2 className="size-3.5" />
            Delete chat
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
