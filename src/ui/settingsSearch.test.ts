import { expect, test } from "vitest";
import { searchSettings } from "./settingsSearch";

test("labels rank before aliases and fuzzy matches", () => {
  expect(searchSettings("Theme")[0]?.id).toBe("theme");
  expect(searchSettings("Memory")[0]?.id).toBe("memory");
  expect(searchSettings("memory budget")[0]?.id).toBe("memory-budget");
  expect(searchSettings("reasoning effort")[0]?.id).toBe("reasoning-effort");
  expect(searchSettings("thme").some((target) => target.id === "theme")).toBe(true);
});

test("aliases find control destinations and distinguish HULK and recovery", () => {
  expect(searchSettings("dark mode")[0]?.id).toBe("theme");
  expect(searchSettings("font")[0]?.id).toBe("text-size");
  expect(searchSettings("HULK").map((target) => target.id)).not.toContain("about-you");
  expect(searchSettings("HULK").map((target) => target.id)).toEqual(
    expect.arrayContaining(["hulk", "sync"]),
  );
  expect(searchSettings("recovery").map((target) => target.id)).toEqual(
    expect.arrayContaining(["database-recovery", "sync-recovery"]),
  );
  expect(searchSettings("spending").map((target) => target.id)).toContain("budgets");
  expect(searchSettings("backup").map((target) => target.id)).toContain("backups");
  expect(searchSettings("Privacy & security").map((target) => target.id)).toContain("app-lock");
});

test("empty and unmatched queries return no results", () => {
  expect(searchSettings("   ")).toEqual([]);
  expect(searchSettings("zzzzzz-no-setting")).toEqual([]);
});
