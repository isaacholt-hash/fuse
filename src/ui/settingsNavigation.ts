import {
  SETTINGS_CATEGORIES,
  settingsTarget,
  type SettingsCategoryId,
  type SettingsTargetId,
} from "./settingsRegistry";

export interface SettingsLocation {
  category: SettingsCategoryId;
  target?: SettingsTargetId;
}
export interface SettingsDestination extends SettingsLocation {
  notice?: string;
}
const INVALID_DESTINATION = "That settings destination is unavailable. Showing General.";

/** Only registered static IDs belong in URLs; never serialize form values or search text. */
export function settingsHash(location: SettingsLocation): string {
  return `#settings/${location.category}${location.target ? `/${location.target}` : ""}`;
}
export function parseSettingsHash(hash: string): SettingsDestination | null {
  if (hash === "#sync") return { category: "sync-devices", target: "sync" };
  if (hash !== "#settings" && !hash.startsWith("#settings/")) return null;
  const [, categoryId, targetId, ...extra] = hash.split("/");
  const category = SETTINGS_CATEGORIES.find((item) => item.id === categoryId);
  const target = targetId ? settingsTarget(targetId) : undefined;
  if (
    !category ||
    extra.length ||
    (targetId !== undefined && (!target || target.category !== category.id))
  )
    return { category: "general", notice: INVALID_DESTINATION };
  return target ? { category: category.id, target: target.id } : { category: category.id };
}
export function settingsLocation(target?: SettingsTargetId): SettingsLocation {
  const destination = target ? settingsTarget(target) : undefined;
  return destination
    ? { category: destination.category, target: destination.id }
    : { category: readSettingsCategory() };
}
/** pushState does not fire hashchange; the caller updates its own navigation state. */
export function pushSettingsHistory(location: SettingsLocation | null) {
  const hash = location ? settingsHash(location) : "";
  if (window.location.hash !== hash)
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${hash}`,
    );
}

let lastSettingsCategory: SettingsCategoryId = "general";
let categoryWriteFailed = false;
export function readSettingsCategory(): SettingsCategoryId {
  if (categoryWriteFailed) return lastSettingsCategory;
  try {
    const stored = localStorage.getItem("fuse.settings.category");
    return SETTINGS_CATEGORIES.find((item) => item.id === stored)?.id ?? "general";
  } catch {
    return lastSettingsCategory;
  }
}
export function rememberSettingsCategory(category: SettingsCategoryId) {
  lastSettingsCategory = category;
  try {
    localStorage.setItem("fuse.settings.category", category);
    categoryWriteFailed = false;
  } catch {
    categoryWriteFailed = true;
  }
}
