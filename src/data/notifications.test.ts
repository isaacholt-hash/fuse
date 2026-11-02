// @vitest-environment node
import { DEFAULT_TENANT } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import {
  DEFAULT_NOTIFICATIONS,
  describeQuiet,
  getNotificationSettings,
  inQuietHours,
  mayNotify,
  parseNotificationSettings,
  setNotificationSettings,
  toMinute,
  type QuietHours,
} from "./notifications";

const t = DEFAULT_TENANT;
// Monday 2026-11-02 at the given time, local.
const mon = (h: number, m = 0) => new Date(2026, 10, 2, h, m);
const tue = (h: number, m = 0) => new Date(2026, 10, 3, h, m);
const sun = (h: number, m = 0) => new Date(2026, 10, 1, h, m);
const weeknights: QuietHours = {
  on: true,
  days: [false, true, true, true, true, true, false],
  from: 22 * 60,
  to: 7 * 60,
};

test("the defaults are quiet: the sound is off, everything else is on, no quiet hours", () => {
  expect(DEFAULT_NOTIFICATIONS.sound).toBe(false);
  expect(Object.values(DEFAULT_NOTIFICATIONS.system).every(Boolean)).toBe(true);
  expect(Object.values(DEFAULT_NOTIFICATIONS.banners).every(Boolean)).toBe(true);
  expect(DEFAULT_NOTIFICATIONS.quiet.on).toBe(false);
  expect(parseNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATIONS);
  expect(parseNotificationSettings("not json")).toEqual(DEFAULT_NOTIFICATIONS);
  // Odd values fall back one by one, not all at once.
  expect(
    parseNotificationSettings(
      JSON.stringify({ sound: true, system: { waiting: false }, quiet: { on: true, from: 9999 } }),
    ),
  ).toEqual({
    ...DEFAULT_NOTIFICATIONS,
    sound: true,
    system: { ...DEFAULT_NOTIFICATIONS.system, waiting: false },
    quiet: { ...DEFAULT_NOTIFICATIONS.quiet, on: true },
  });
});

test("quiet hours: a daytime range, an overnight range, the whole day, and the days off", () => {
  const office: QuietHours = {
    on: true,
    days: [true, true, true, true, true, true, true],
    from: 9 * 60,
    to: 17 * 60,
  };
  expect(inQuietHours(office, mon(9))).toBe(true);
  expect(inQuietHours(office, mon(16, 59))).toBe(true);
  expect(inQuietHours(office, mon(17))).toBe(false);
  expect(inQuietHours(office, mon(8, 59))).toBe(false);

  expect(inQuietHours(weeknights, mon(23))).toBe(true);
  expect(inQuietHours(weeknights, tue(6, 30))).toBe(true); // Monday night runs into Tuesday morning
  expect(inQuietHours(weeknights, tue(7))).toBe(false);
  expect(inQuietHours(weeknights, mon(12))).toBe(false);
  expect(inQuietHours(weeknights, sun(23))).toBe(false); // Sunday isn't quiet
  expect(inQuietHours(weeknights, mon(6))).toBe(false); // and so Monday morning isn't either

  const allDay: QuietHours = { ...weeknights, from: 0, to: 0 };
  expect(inQuietHours(allDay, mon(12))).toBe(true);
  expect(inQuietHours(allDay, sun(12))).toBe(false);
  expect(inQuietHours({ ...weeknights, on: false }, mon(23))).toBe(false);
});

test("a notification shows only when its switch is on and it isn't quiet", () => {
  const s = { ...DEFAULT_NOTIFICATIONS, quiet: weeknights };
  expect(mayNotify(s, "waiting", mon(12))).toBe(true);
  expect(mayNotify(s, "waiting", mon(23))).toBe(false);
  expect(mayNotify({ ...s, system: { ...s.system, waiting: false } }, "waiting", mon(12))).toBe(
    false,
  );
});

test("settings round-trip through the database, and read back as people write them", async () => {
  const db = openTestDb();
  expect(await getNotificationSettings(db, t)).toEqual(DEFAULT_NOTIFICATIONS);
  const next = { ...DEFAULT_NOTIFICATIONS, sound: true, quiet: weeknights };
  await setNotificationSettings(db, t, next);
  expect(await getNotificationSettings(db, t)).toEqual(next);
  expect(describeQuiet(weeknights)).toBe("Quiet 22:00 to 07:00 on Mon, Tue, Wed, Thu, Fri");
  expect(describeQuiet({ ...weeknights, days: Array(7).fill(true) as boolean[] })).toBe(
    "Quiet 22:00 to 07:00 every day",
  );
  expect(describeQuiet({ ...weeknights, from: 0, to: 0 })).toBe(
    "Quiet all day on Mon, Tue, Wed, Thu, Fri",
  );
  expect(describeQuiet({ ...weeknights, on: false })).toBe("Quiet hours off");
  expect(toMinute("07:05")).toBe(425);
  expect(toMinute("24:00")).toBeNull();
});
