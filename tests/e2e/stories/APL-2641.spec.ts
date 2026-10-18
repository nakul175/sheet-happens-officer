// [SHO-US-9.2b] Usage screen: messages this month and quick-action counts (Linear APL-2641, PR #35).
// PR #35 is stacked on PR #34. The screen reads month.messages and quickActions from /api/usage.
// AC1: the Super Admin sees the total messages this calendar month (India time), matching /api/usage.
// AC2: quick-action counts are shown, and they are not included in that message total.
// AC3: on the 1st at 00:00 India time both figures start from zero. The live monthStart is that instant.
// A story spec cannot set ModelUsage.createdAt, so the ledger drop at 31 January 23:59:59 IST is
// tests/usage-month.test.tsx in PR #35. Here the screen is given that fresh-month payload and must show zeros.
// AC4: a Member and an Admin are refused and no figures are shown.
// Widths 320, 390 and 1280 keep the month-count labels fully on screen, with no sideways scroll.
// The checks run when PR #35 is live (tests/e2e/helpers/jim-gate.ts) and skip otherwise.
// The plain Member (SHO_MEMBER_*) is promoted to Admin for that one check and put back afterwards.
import type { Locator } from "@playwright/test";
import { test, expect, login } from "../support";
import { notLive, prLive } from "../helpers/jim-gate";
import { CHAT, expectRefused, figure, fits, freshMonth, monthStartIST, QUICK_ROWS, sampleUsage, stubUsage, usageCard } from "../helpers/usage-screen";

const WHY = "the Usage screen does not show messages this month or quick-action counts.";
const WIDTHS = [320, 390, 1280] as const;

const readCount = async (loc: Locator) => Number((await loc.innerText()).replace(/[^\d]/g, ""));

test.describe("SHO-US-9.2b / APL-2641", () => {
  test.describe.configure({ timeout: 120_000 });
  test("AC1 and AC2: messages this month and each quick-action count match /api/usage, and quick actions stay out of the total", async ({ admin, later }) => {
    const gate = await prLive(35, admin, null, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    const live = await admin.api.get("/api/usage");
    const body = JSON.stringify(live.json);
    const pass = login("ADMIN").password;
    expect(live.status, body).toBe(200);
    expect(body.includes(pass)).toBe(false);
    const messages = live.json.month.messages as number;
    const quick = live.json.quickActions as { id: string; label: string; count: number }[];
    expect(typeof messages).toBe("number");
    expect(quick.map((q) => q.id)).toEqual(QUICK_ROWS.map((q) => q.id));
    const quickSum = quick.reduce((sum, q) => sum + q.count, 0);

    await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
    await expect(admin.page.locator(".usage-count")).toBeVisible();
    expect(await readCount(admin.page.locator(".usage-count"))).toBe(messages);
    await expect(admin.page.getByText("Quick actions are not included.")).toBeVisible();
    const quickCard = usageCard(admin.page, "Quick actions this month");
    for (const q of quick) expect(await readCount(figure(quickCard, q.label)), q.label).toBe(q.count);
    if (quickSum > 0) expect(await readCount(admin.page.locator(".usage-count"))).not.toBe(messages + quickSum);

    // 17 messages, and 2 + 4 + 0 + 1 + 3 quick actions. The total must stay 17, not 27.
    const data = sampleUsage();
    await stubUsage(admin.page, data);
    await admin.page.reload({ waitUntil: "domcontentloaded" });
    await expect(admin.page.locator(".usage-count")).toHaveText("17");
    await expect(admin.page.locator(".usage-count")).not.toHaveText("27");
    await expect(admin.page.locator(".usage-count")).not.toHaveText("21");
    const stubbed = usageCard(admin.page, "Quick actions this month");
    await expect(figure(stubbed, "Due this week")).toHaveText("2");
    await expect(figure(stubbed, "Overdue")).toHaveText("4");
    await expect(figure(stubbed, "Waiting on me")).toHaveText("0");
    await expect(figure(stubbed, "Blocked")).toHaveText("1");
    await expect(figure(stubbed, "Recently completed")).toHaveText("3");
    expect(await admin.page.locator("main").innerText()).not.toContain(CHAT);
    expect((await admin.page.locator("main").innerText()).includes(pass)).toBe(false);
  });

  test("AC3: the month starts at 00:00 India time on the 1st, and both figures are zero for that fresh month", async ({ admin, later }) => {
    const gate = await prLive(35, admin, null, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    const live = await admin.api.get("/api/usage");
    expect(live.status, JSON.stringify(live.json)).toBe(200);
    const start = monthStartIST();
    expect(live.json.monthStart).toBe(start.toISOString());
    const ist = new Date(start.getTime() + 5.5 * 3600_000);
    expect(ist.getUTCDate(), "the window opens on the 1st").toBe(1);
    expect(ist.getUTCHours(), "the window opens at 00:00 India time").toBe(0);
    expect(ist.getUTCMinutes()).toBe(0);
    expect(ist.getUTCSeconds()).toBe(0);
    expect(String(live.json.monthStart).endsWith("T18:30:00.000Z"), "00:00 IST is 18:30 UTC the day before").toBe(true);
    const nowIst = new Date(Date.now() + 5.5 * 3600_000);
    expect(ist.getUTCFullYear()).toBe(nowIst.getUTCFullYear());
    expect(ist.getUTCMonth()).toBe(nowIst.getUTCMonth());
    // 31 January 23:59:59 IST is still January. 1 February 00:00 IST is the new window.
    const lastSecond = new Date("2099-01-31T23:59:59+05:30");
    const first = new Date("2099-02-01T00:00:00+05:30");
    expect(monthStartIST(lastSecond).toISOString()).not.toBe(monthStartIST(first).toISOString());
    expect(monthStartIST(first).toISOString()).toBe("2099-01-31T18:30:00.000Z");

    const fresh = freshMonth();
    expect(fresh.monthStart).toBe(monthStartIST(first).toISOString());
    await stubUsage(admin.page, fresh);
    await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
    await expect(admin.page.locator(".usage-count")).toHaveText("0");
    const quickCard = usageCard(admin.page, "Quick actions this month");
    for (const q of fresh.quickActions) await expect(figure(quickCard, q.label)).toHaveText("0");
    await expect(admin.page.locator(".usage-count")).not.toHaveText("17");
    await expect(admin.page.getByText("No quick actions this month.")).toHaveCount(0);
    expect(await admin.page.locator("main").innerText()).not.toContain(CHAT);
  });

  test("at 320, 390 and 1280 px the month counts do not scroll sideways and the labels stay fully visible", async ({ admin, later }) => {
    test.setTimeout(120_000);
    const gate = await prLive(35, admin, null, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    await stubUsage(admin.page, sampleUsage({ people: [] }));
    for (const width of WIDTHS) {
      await admin.page.setViewportSize({ width, height: 800 });
      await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
      await expect(admin.page.getByRole("heading", { name: "Messages this month" })).toBeVisible();
      await expect(admin.page.getByRole("heading", { name: "Quick actions this month" })).toBeVisible();
      await expect(admin.page.getByRole("heading", { name: "Spend against the monthly ceiling" })).toBeVisible();
      await expect(admin.page.locator(".usage-count")).toBeVisible();
      const quick = usageCard(admin.page, "Quick actions this month");
      for (const label of ["Due this week", "Overdue", "Waiting on me", "Blocked", "Recently completed"]) {
        await expect(quick.getByText(label, { exact: true })).toBeVisible();
      }
      await fits(admin.page);
    }
  });

  test("AC4: a Member who opens /usage is refused and no figures are shown", async ({ admin, member, later }) => {
    const gate = await prLive(35, admin, member, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    expect(member.user.orgRole).toBe("MEMBER");
    await expectRefused(member);
    const pass = login("MEMBER").password;
    expect((await member.page.locator("main").innerText()).includes(pass)).toBe(false);
    await expect(member.page.locator("a.me small")).toHaveText("Member");
  });

  test("AC4: an Admin who opens /usage is refused and no figures are shown", async ({ admin, member, later }) => {
    const gate = await prLive(35, admin, member, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    expect(member.user.orgRole).toBe("MEMBER");
    later(() => admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" }));
    const up = await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "ADMIN" });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    try {
      expect((await member.api.get("/api/auth/me")).json.user.orgRole).toBe("ADMIN");
      await expectRefused(member);
      await expect(member.page.locator("a.me small")).toHaveText("Admin");
      const pass = login("MEMBER").password;
      expect((await member.page.locator("main").innerText()).includes(pass)).toBe(false);
    } finally {
      expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" })).status).toBe(200);
    }
  });
});
