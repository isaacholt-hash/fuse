// @vitest-environment node
import { hashPasscode, lockoutSeconds, verifyPasscode } from "./passcode";

test("a stored hash checks the right passcode and refuses others; salts differ", async () => {
  const stored = await hashPasscode("1234", 1000);
  expect(stored).toMatch(/^pbkdf2-sha256\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  expect(stored).not.toContain("1234");
  expect(await verifyPasscode("1234", stored)).toBe(true);
  expect(await verifyPasscode("1235", stored)).toBe(false);
  expect(await verifyPasscode("1234", "garbage")).toBe(false);
  expect(await hashPasscode("1234", 1000)).not.toBe(stored);
});

test("wrong tries: free at first, then a growing wait", () => {
  expect([0, 4, 5, 6, 7, 12].map(lockoutSeconds)).toEqual([0, 0, 30, 60, 120, 300]);
});
