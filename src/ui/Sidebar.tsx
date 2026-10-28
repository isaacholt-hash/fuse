import { money } from "./format";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Hint, Mark, Tip } from "./primitives";
import type { ProjectView, ThreadView } from "./types";

interface Props {
  threads: ThreadView[];
  projects: ProjectView[];
  selectedId: string | null;
  /** The project of the chat on screen (also for a new, unsaved chat). */
  activeProjectId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewProject: () => void;
  onNewInProject: (projectId: string) => void;
  onEditProject: (projectId: string) => void;
  onCollapse: () => void;
  onSettings: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (thread: ThreadView) => void;
  /** Opens search across all chats (CH-02). */
  onSearch?: () => void;
}

const sectionTitle =
  "px-3 text-[10px] font-medium tracking-[0.1em] text-muted-foreground uppercase";

export function Sidebar({
  threads,
  projects,
  selectedId,
  activeProjectId,
  onSelect,
  onNew,
  onNewProject,
  onNewInProject,
  onEditProject,
  onCollapse,
  onSettings,
  onRename,
  onDelete,
  onSearch,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  // Projects the user opened or closed; the active project is open unless closed.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const save = () => {
    if (editingId && title.trim()) onRename(editingId, title.trim());
    setEditingId(null);
  };
  const row = (thread: ThreadView) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      selected={selectedId === thread.id}
      editing={editingId === thread.id}
      title={title}
      onTitle={setTitle}
      onSave={save}
      onCancel={() => {
        setEditingId(null);
      }}
      onSelect={() => {
        onSelect(thread.id);
      }}
      onStartRename={() => {
        setEditingId(thread.id);
        setTitle(thread.title);
      }}
      onDelete={() => {
        onDelete(thread);
      }}
    />
  );
  const loose = threads.filter((t) => t.projectId === null);
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
          onClick={() => {
            onNew();
          }}
        >
          <Plus className="size-4" />
          New chat
          <span className="ml-auto">
            <Hint>Ctrl N</Hint>
          </span>
        </Button>
        {onSearch && (
          <Button
            variant="ghost"
            className="mt-1.5 h-8 w-full justify-start gap-2.5 text-muted-foreground"
            onClick={onSearch}
          >
            <Search className="size-3.5" />
            Search chats
            <span className="ml-auto">
              <Hint>Ctrl ⇧ F</Hint>
            </span>
          </Button>
        )}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-5" aria-label="Conversations">
        <section className="mb-5" aria-label="Projects">
          <div className="mb-1 flex items-center justify-between pr-1">
            <h2 className={sectionTitle}>Projects</h2>
            <Tip label="New project">
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label="New project"
                onClick={onNewProject}
              >
                <FolderPlus className="size-3.5" />
              </Button>
            </Tip>
          </div>
          {projects.length === 0 && (
            <p className="px-3 py-1 text-[11px] text-muted-foreground">
              Group chats that share instructions.
            </p>
          )}
          {projects.map((project) => {
            const open = toggled[project.id] ?? project.id === activeProjectId;
            return (
              <div key={project.id} className="mb-1">
                <div
                  className={`group relative flex items-center rounded-lg ${activeProjectId === project.id && !selectedId ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"}`}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                    aria-expanded={open}
                    onClick={() => {
                      setToggled((t) => ({ ...t, [project.id]: !open }));
                    }}
                  >
                    <ChevronRight
                      className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                    />
                    {open ? (
                      <FolderOpen className="size-3.5 shrink-0" />
                    ) : (
                      <Folder className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate text-[12px] font-medium">{project.name}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {project.threads.length}
                    </span>
                  </button>
                  <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 gap-0.5 rounded bg-sidebar-accent opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`New chat in ${project.name}`}
                      onClick={() => {
                        setToggled((t) => ({ ...t, [project.id]: true }));
                        onNewInProject(project.id);
                      }}
                    >
                      <Plus className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`${project.name} settings`}
                      onClick={() => {
                        onEditProject(project.id);
                      }}
                    >
                      <SlidersHorizontal className="size-3" />
                    </Button>
                  </div>
                </div>
                {open && (
                  <div className="mt-1 ml-4 space-y-1 border-l pl-1.5">
                    {project.threads.length === 0 ? (
                      <p className="px-3 py-1.5 text-[11px] text-muted-foreground">No chats yet</p>
                    ) : (
                      project.threads.map(row)
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
        {threads.length === 0 && projects.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            <MessageSquare className="mx-auto mb-3 size-5" />
            No chats yet
          </div>
        )}
        {(["Today", "Yesterday", "Previous 7 days", "Older"] as const).map((group) => {
          const rows = loose.filter((thread) => thread.group === group);
          return (
            rows.length > 0 && (
              <section key={group} className="mb-5">
                <h2 className={`mb-2 ${sectionTitle}`}>{group}</h2>
                <div className="space-y-1">{rows.map(row)}</div>
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

function ThreadRow({
  thread,
  selected,
  editing,
  title,
  onTitle,
  onSave,
  onCancel,
  onSelect,
  onStartRename,
  onDelete,
}: {
  thread: ThreadView;
  selected: boolean;
  editing: boolean;
  title: string;
  onTitle: (title: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onSelect: () => void;
  onStartRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group relative rounded-lg ${selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"}`}
    >
      {editing ? (
        <form
          className="flex h-[54px] items-center gap-1 px-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <input
            aria-label="Chat name"
            autoFocus
            className="w-full min-w-0 rounded border bg-background p-1.5 text-xs"
            value={title}
            onChange={(e) => {
              onTitle(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
            }}
          />
          <Button size="icon-xs" variant="ghost" type="submit" aria-label="Save chat name">
            <Check />
          </Button>
        </form>
      ) : (
        <>
          <button
            className="w-full rounded-lg px-3 py-2.5 text-left outline-offset-2"
            aria-current={selected ? "page" : undefined}
            onClick={onSelect}
          >
            <span className="block truncate pr-1 text-[12px] font-medium">{thread.title}</span>
            <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
              {money(thread.costMicro)}
            </span>
          </button>
          <div className="absolute right-2 bottom-1.5 flex gap-0.5 rounded bg-sidebar-accent opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Rename ${thread.title}`}
              onClick={onStartRename}
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete ${thread.title}`}
              onClick={onDelete}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
