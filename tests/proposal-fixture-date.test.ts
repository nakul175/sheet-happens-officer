import { expect, it } from "vitest";
import { dueBeforeNextMonday } from "./e2e/helpers/proposal-fixture-date";
it.each([
  ["2026-10-24T12:00:00Z", "2026-10-25"], // Saturday: dueIn(2) would already be Monday.
  ["2026-10-25T12:00:00Z", "2026-10-25"], // Sunday: the same day's Sunday remains different from tomorrow.
  ["2026-10-26T12:00:00Z", "2026-11-01"], // Monday means next week's Monday.
  ["2026-10-23T19:00:00Z", "2026-10-25"], // India date differs from UTC.
  ["2026-12-31T19:00:00Z", "2027-01-03"], // Month/year boundary.
])("keeps a real pre-Monday fixture date at %s", (instant, expected) => {
  const value = dueBeforeNextMonday(new Date(instant));
  expect(value).toBe(expected); expect(new Date(value + "T00:00:00Z").getUTCDay()).toBe(0);
});
