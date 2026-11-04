import { expect, test } from "vitest";
import { SETTINGS_TARGETS } from "./settingsRegistry";
import { parseSettingsHash, settingsHash, settingsLocation } from "./settingsNavigation";

test("every registered section and control round trips through its static URL", () => {
  for (const target of SETTINGS_TARGETS) {
    const location = { category: target.category, target: target.id };
    expect(parseSettingsHash(settingsHash(location))).toEqual(location);
  }
  expect(parseSettingsHash("#settings/personalization")).toEqual({ category: "personalization" });
  expect(settingsLocation("anthropic-key")).toEqual({
    category: "providers-models",
    target: "anthropic-key",
  });
});
test("legacy sync and invalid destinations have deterministic, content-free fallbacks", () => {
  expect(parseSettingsHash("#sync")).toEqual({ category: "sync-devices", target: "sync" });
  for (const hash of [
    "#settings",
    "#settings/unknown",
    "#settings/general/recovery",
    "#settings/general/sync",
    "#settings/general/",
    "#settings/general/theme/extra",
    "#settings/general/%3Cscript%3E",
  ]) {
    const parsed = parseSettingsHash(hash);
    expect(parsed).toEqual({
      category: "general",
      notice: "That settings destination is unavailable. Showing General.",
    });
  }
  expect(parseSettingsHash("#other")).toBeNull();
  expect(parseSettingsHash("")).toBeNull();
});
