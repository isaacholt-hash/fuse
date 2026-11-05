import { fuzzyScore } from "./fuzzy";
import { SETTINGS_CATEGORIES, SETTINGS_TARGETS, type SettingsTarget } from "./settingsRegistry";

/** Search only authored metadata; callers cannot supply setting values or user records. */
export function searchSettings(query: string): readonly SettingsTarget[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return [];
  const matches = SETTINGS_TARGETS.map((target, index) => {
    const label = target.label.toLowerCase();
    const category = SETTINGS_CATEGORIES.find((item) => item.id === target.category)?.label ?? "";
    const other = [category, target.description, ...target.aliases].join(" ").toLowerCase();
    const rank =
      label === q ? 0 : label.startsWith(q) ? 1 : label.includes(q) ? 2 : other.includes(q) ? 3 : 4;
    const fuzzy = rank === 4 ? fuzzyScore(q, `${label} ${other}`) : 0;
    return { target, index, rank, fuzzy };
  });
  const direct = matches.filter((match) => match.rank < 4);
  return (direct.length ? direct : matches.filter((match) => match.fuzzy !== null))
    .sort((a, b) => a.rank - b.rank || (b.fuzzy ?? 0) - (a.fuzzy ?? 0) || a.index - b.index)
    .map((match) => match.target);
}

/** A result can open a disabled/conditional control's heading without activating anything. */
export function focusSettingsTarget(
  root: HTMLElement,
  target: SettingsTarget,
  reducedMotion: boolean,
): HTMLElement | null {
  const section = root.querySelector<HTMLElement>(`[data-settings-section="${target.section}"]`);
  if (!section || section.closest("[hidden]")) return null;
  const specific = target.selector ? section.querySelector<HTMLElement>(target.selector) : null;
  const base = specific ?? section;
  const enabled =
    'button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled)';
  const control = base.matches(enabled) ? base : base.querySelector<HTMLElement>(enabled);
  const heading = base.matches("h2,h3") ? base : base.querySelector<HTMLElement>("h2,h3");
  const focus = control ?? heading ?? section.querySelector<HTMLElement>("h2,h3") ?? section;
  if (!focus.matches(enabled)) focus.tabIndex = -1;
  if (typeof base.scrollIntoView === "function")
    base.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  focus.focus({ preventScroll: true });
  return specific ?? section;
}
