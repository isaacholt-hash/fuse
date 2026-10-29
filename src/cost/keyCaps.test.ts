// @vitest-environment node
import { capState, localDay } from "./keyCaps";

const now = new Date(2026, 9, 29, 15).getTime();

test("a key stops at its daily or monthly cap, unless raised for today", () => {
  const cap = { dailyMicro: 2_000_000, monthlyMicro: 20_000_000 };
  expect(capState("openai", cap, { today: 1_999_999, month: 5 }, undefined, now).over).toBeNull();
  expect(capState("openai", cap, { today: 2_000_000, month: 5 }, undefined, now).over).toBe("day");
  expect(capState("openai", cap, { today: 0, month: 20_000_000 }, undefined, now).over).toBe(
    "month",
  );
  expect(capState("openai", {}, { today: 9e9, month: 9e9 }, undefined, now).over).toBeNull();
  expect(localDay(now)).toBe("2026-10-29");
  expect(capState("openai", cap, { today: 3e6, month: 0 }, "2026-10-29", now).raised).toBe(true);
  expect(capState("openai", cap, { today: 3e6, month: 0 }, "2026-10-28", now).raised).toBe(false);
});
