import { durationCost, speechPrice } from "./duration";

test("speech costs are integer micro-dollars, including subsecond and maximum clips", () => {
  expect(durationCost(0)).toBe(0);
  expect(durationCost(1)).toBe(1);
  expect(durationCost(1000)).toBe(75);
  expect(durationCost(60000)).toBe(4500);
  expect(durationCost(speechPrice.max_duration_ms)).toBe(9000);
  expect(durationCost(1001)).toBe(76);
});
test("invalid durations, rates and overflow fail closed", () => {
  for (const value of [-1, 0.1, Infinity, NaN]) expect(() => durationCost(value)).toThrow();
  expect(() => durationCost(1, -1)).toThrow();
  expect(() => durationCost(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow();
});
