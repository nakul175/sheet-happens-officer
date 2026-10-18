// SHO-BUG-9 (APL-2643): the bell's accessible name must contain the unread count that is painted on it
// (WCAG 2.5.3). axe-core's label-content-name-mismatch rule drops emoji and punctuation, then requires
// the remaining visible words to appear, in order, inside the accessible name.
import { describe, expect, it } from "vitest";
import { bellBadge, bellName } from "@/app/(app)/bell-label";

function words(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
}

/** True when `visible` is contained in `name` the way axe-core 4.14 checks Label in Name. */
function labelInName(visible: string, name: string): boolean {
  const needle = words(visible);
  const hay = words(name);
  if (!needle.length) return true;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((word, j) => hay[i + j] === word)) return true;
  }
  return false;
}

describe("notification bell accessible name (SHO-BUG-9)", () => {
  it("reads the visible count with unread notices, including the 99+ badge", () => {
    expect(bellBadge(3)).toBe("3");
    expect(bellName(3)).toBe("Notifications, 3 unread");
    expect(labelInName(bellBadge(3)!, bellName(3))).toBe(true);

    expect(bellBadge(99)).toBe("99");
    expect(bellName(99)).toBe("Notifications, 99 unread");
    expect(labelInName("99", bellName(99))).toBe(true);

    // The screen shows "99+" while the old name said the raw total ("Notifications, 120 unread"),
    // which does not contain the visible word "99".
    expect(labelInName("99+", "Notifications, 120 unread")).toBe(false);
    expect(bellBadge(120)).toBe("99+");
    expect(bellName(120)).toBe("Notifications, 99+ unread");
    expect(labelInName(bellBadge(120)!, bellName(120))).toBe(true);
  });

  it("matches the plain label and carries no count when nothing is unread", () => {
    expect(bellBadge(0)).toBeNull();
    expect(bellName(0)).toBe("Notifications");
    expect(bellName(-1)).toBe("Notifications");
  });
});
