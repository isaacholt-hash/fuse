import { uuidv7 } from "./ids";

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uuidv7 has the v7 shape and encodes the timestamp", () => {
  const id = uuidv7(0x0190_1234_5678 + 1_000_000_000_000);
  expect(id).toMatch(V7);
  expect(id.replace(/-/g, "").slice(0, 12)).toBe(
    (0x0190_1234_5678 + 1_000_000_000_000).toString(16).padStart(12, "0"),
  );
});

test("ids made in the same millisecond sort in creation order", () => {
  const now = 2_000_000_000_000;
  const ids = Array.from({ length: 5000 }, () => uuidv7(now)); // more than the 4096 counter values
  expect(ids.every((id) => V7.test(id))).toBe(true);
  expect([...ids].sort()).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
});

test("a clock going backwards never produces a smaller id", () => {
  const a = uuidv7(3_000_000_000_000);
  const b = uuidv7(2_999_999_999_000);
  expect(b > a).toBe(true);
});
