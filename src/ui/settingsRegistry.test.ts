import { describe, expect, test } from "vitest";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_SECTIONS,
  SETTINGS_TARGETS,
  settingsTarget,
} from "./settingsRegistry";

describe("settings destinations", () => {
  test("every section belongs to a category and every destination has one unique ID", () => {
    const categories = new Set(SETTINGS_CATEGORIES.map((category) => category.id));
    expect(new Set(SETTINGS_TARGETS.map((target) => target.id)).size).toBe(SETTINGS_TARGETS.length);
    for (const section of SETTINGS_SECTIONS) expect(categories.has(section.category)).toBe(true);
    for (const target of SETTINGS_TARGETS) {
      expect(SETTINGS_SECTIONS.some((section) => section.id === target.section)).toBe(true);
    }
  });
  test("control destinations distinguish pairing, sync and the two recovery systems", () => {
    expect(settingsTarget("theme")).toMatchObject({ category: "general", section: "appearance" });
    expect(settingsTarget("hulk")?.category).toBe("code-tools");
    expect(settingsTarget("sync")?.category).toBe("sync-devices");
    expect(settingsTarget("sync-recovery")?.section).toBe("sync");
    expect(settingsTarget("database-recovery")?.category).toBe("privacy-security");
    expect(settingsTarget("unknown")).toBeUndefined();
  });
});
