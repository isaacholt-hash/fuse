// Project settings → Tools (M9 step 1, AG-01): every tool its Code and Work runs can use, by kind,
// each with a switch. The ones a run needs to find its way around stay on.
import { Wrench } from "lucide-react";

export interface ProjectToolView {
  name: string;
  /** "Reads", "Writes", …, from the tool's kind. */
  kind: string;
  /** "Code and Work", "Code, Work and Chat", …. */
  where: string;
  on: boolean;
  /** Always on: a run can't work without it. */
  core: boolean;
}

export interface ProjectToolsProps {
  tools: ProjectToolView[];
  onSwitch: (name: string, on: boolean) => void;
}

export function ProjectToolsSection({ tools, onSwitch }: ProjectToolsProps) {
  const kinds = [...new Set(tools.map((t) => t.kind))];
  return (
    <section aria-label="Tools">
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium">
        <Wrench className="size-3.5" aria-hidden />
        Tools
      </h3>
      <p className="mb-2 text-[10px] text-muted-foreground">
        What this project&apos;s chats and its Code and Work runs may use. A tool that&apos;s off
        isn&apos;t offered to the model. Writes, commands and sends still ask as the run&apos;s mode
        says.
      </p>
      <div className="space-y-2">
        {kinds.map((kind) => (
          <fieldset key={kind}>
            <legend className="text-[10px] text-muted-foreground uppercase">{kind}</legend>
            <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              {tools
                .filter((t) => t.kind === kind)
                .map((t) => (
                  <li key={t.name}>
                    <label className="flex items-center gap-2 text-[11px]">
                      <input
                        type="checkbox"
                        checked={t.on || t.core}
                        disabled={t.core}
                        onChange={(e) => {
                          onSwitch(t.name, e.target.checked);
                        }}
                      />
                      <span className="font-mono">{t.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {t.core ? `${t.where} · always on` : t.where}
                      </span>
                    </label>
                  </li>
                ))}
            </ul>
          </fieldset>
        ))}
      </div>
    </section>
  );
}
