import { MessageSquare, SquareTerminal } from "lucide-react";
import type { Area } from "./types";

const AREAS: { id: Area; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Ctrl 1" },
  { id: "code", label: "Code", hint: "Ctrl 2" },
];

/**
 * M10 step 12 (CH-19): the switch between the two areas. `segmented` sits in the sidebar header;
 * `bar` is the bottom tab bar on narrow screens (under 600 px). Both render the same two buttons.
 */
export function AreaTabs({
  area,
  onArea,
  variant,
  className = "",
}: {
  area: Area;
  onArea: (area: Area) => void;
  variant: "segmented" | "bar";
  className?: string;
}) {
  if (variant === "bar") {
    return (
      <nav
        aria-label="Areas"
        className={`hidden shrink-0 border-t bg-background max-[600px]:flex ${className}`}
      >
        {AREAS.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={area === a.id}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${area === a.id ? "text-foreground" : "text-muted-foreground"}`}
            onClick={() => {
              onArea(a.id);
            }}
          >
            {a.id === "chat" ? (
              <MessageSquare className="size-4" />
            ) : (
              <SquareTerminal className="size-4" />
            )}
            {a.label}
          </button>
        ))}
      </nav>
    );
  }
  return (
    <div
      role="group"
      aria-label="Area"
      className={`flex rounded-lg border bg-background p-0.5 text-xs ${className}`}
    >
      {AREAS.map((a) => (
        <button
          key={a.id}
          type="button"
          aria-pressed={area === a.id}
          title={`${a.label} · ${a.hint}`}
          className={`flex-1 rounded-md px-2.5 py-1 font-medium ${area === a.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}
          onClick={() => {
            onArea(a.id);
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
