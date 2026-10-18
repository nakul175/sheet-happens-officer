// [SHO-US-9.2] Cost controls and caps (Linear APL-2519, PR #34). AC6 is the remaining work.
// Given the Super Admin opens Usage, when the month's spend is recorded, the screen shows spend to date,
// the monthly ceiling and the percentage used, using the figures /api/usage already returns.
// The percentage is the API's figure: 10 of a ceiling of 80 is answered as 15, and the screen must not show 12.5.
// A Member and an Admin are refused. The page does not request /api/usage for them, and no figures are shown.
// Widths 320, 390 and 1280 keep the spend labels fully on screen, with no sideways scroll.
// Those checks run when PR #34 is live (tests/e2e/helpers/jim-gate.ts: release SHA, then the heading in the served page)
// and skip otherwise. The fixed payloads are answered in the browser, so no usage row is written.
// The plain Member (SHO_MEMBER_*) is promoted to Admin for that one check and put back afterwards.
import { test, expect, login } from "../support";
import { notLive, prLive } from "../helpers/jim-gate";
import { CHAT, expectRefused, figure, fits, sampleUsage, stubUsage, usd, usageCard } from "../helpers/usage-screen";

const WHY = "the Usage screen still shows calls, tokens and cost, and does not show spend against the monthly ceiling.";
const WIDTHS = [320, 390, 1280] as const;

test.describe("SHO-US-9.2 / APL-2519", () => {
  test.describe.configure({ timeout: 120_000 });
  test("AC6: the Super Admin sees spend to date, the monthly ceiling and the percentage used from /api/usage", async ({ admin, later }) => {
    const gate = await prLive(34, admin, null, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    const live = await admin.api.get("/api/usage");
    const body = JSON.stringify(live.json);
    const pass = login("ADMIN").password;
    expect(live.status, body).toBe(200);
    expect(body.includes(pass)).toBe(false);
    expect(body.includes(CHAT)).toBe(false);
    const ceiling = live.json.ceiling as { usd: number; spendUsd: number; percent: number };
    expect(typeof ceiling.spendUsd).toBe("number");
    expect(typeof ceiling.usd).toBe("number");
    expect(typeof ceiling.percent).toBe("number");

    await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
    const card = usageCard(admin.page, "Spend against the monthly ceiling");
    await expect(card.getByRole("heading", { name: "Spend against the monthly ceiling" })).toBeVisible();
    await expect(figure(card, "Spend to date")).toHaveText(usd(ceiling.spendUsd));
    await expect(figure(card, "Monthly ceiling")).toHaveText(usd(ceiling.usd));
    await expect(figure(card, "Percentage used")).toHaveText(`${ceiling.percent}%`);
    const meter = admin.page.getByRole("meter", { name: "Spend against the monthly ceiling" });
    await expect(meter).toHaveAttribute("aria-valuetext", `${usd(ceiling.spendUsd)} of ${usd(ceiling.usd)}, ${ceiling.percent}% used`);
    const main = await admin.page.locator("main").innerText();
    expect(main.includes(pass)).toBe(false);
    expect(main.includes(CHAT)).toBe(false);
  });

  test("AC6: the screen prints the API percentage, including when it is not spend divided by the ceiling", async ({ admin, later }) => {
    const gate = await prLive(34, admin, null, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    const data = sampleUsage();
    await stubUsage(admin.page, data);
    await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
    const card = usageCard(admin.page, "Spend against the monthly ceiling");
    await expect(figure(card, "Spend to date")).toHaveText("$10.00");
    await expect(figure(card, "Monthly ceiling")).toHaveText("$80.00");
    await expect(figure(card, "Percentage used")).toHaveText("15%");
    await expect(card).not.toContainText("12.5%");
    const meter = admin.page.getByRole("meter", { name: "Spend against the monthly ceiling" });
    await expect(meter).toHaveAttribute("aria-valuetext", "$10.00 of $80.00, 15% used");
    await expect(meter).toHaveAttribute("aria-valuenow", "15");
    expect(await admin.page.locator("main").innerText()).not.toContain(CHAT);

    // Calls already running can finish after the cap, so the percentage can pass 100. The bar stays full.
    const over = sampleUsage({ ceiling: { usd: 100, spendUsd: 112.4, percent: 112.4 } });
    await admin.page.unrouteAll({ behavior: "ignoreErrors" });
    await stubUsage(admin.page, over);
    await admin.page.reload({ waitUntil: "domcontentloaded" });
    await expect(figure(card, "Spend to date")).toHaveText("$112.40");
    await expect(figure(card, "Monthly ceiling")).toHaveText("$100.00");
    await expect(figure(card, "Percentage used")).toHaveText("112.4%");
    await expect(meter).toHaveAttribute("aria-valuenow", "100");
    await expect(meter).toHaveAttribute("aria-valuetext", "$112.40 of $100.00, 112.4% used");
    expect(await admin.page.locator("main").innerText()).not.toContain(CHAT);
  });

  test("at 320, 390 and 1280 px the spend block does not scroll sideways and the labels stay fully visible", async ({ admin, later }) => {
    test.setTimeout(120_000);
    const gate = await prLive(34, admin, null, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    // No people row, so the check is the ceiling block and not the older calls table.
    await stubUsage(admin.page, sampleUsage({ people: [] }));
    for (const width of WIDTHS) {
      await admin.page.setViewportSize({ width, height: 800 });
      await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
      const card = usageCard(admin.page, "Spend against the monthly ceiling");
      await expect(figure(card, "Spend to date")).toBeVisible();
      await expect(figure(card, "Monthly ceiling")).toBeVisible();
      await expect(figure(card, "Percentage used")).toBeVisible();
      await expect(card.getByText("Spend to date", { exact: true })).toHaveText("Spend to date");
      await expect(card.getByText("Monthly ceiling", { exact: true })).toHaveText("Monthly ceiling");
      await expect(card.getByText("Percentage used", { exact: true })).toHaveText("Percentage used");
      await fits(admin.page);
    }
  });

  test("a Member who opens /usage is refused and no figures are shown", async ({ admin, member, later }) => {
    const gate = await prLive(34, admin, member, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    expect(member.user.orgRole).toBe("MEMBER");
    await expectRefused(member);
    const pass = login("MEMBER").password;
    expect((await member.page.locator("main").innerText()).includes(pass)).toBe(false);
    await expect(member.page.locator("a.me small")).toHaveText("Member");
  });

  test("an Admin who opens /usage is refused and no figures are shown", async ({ admin, member, later }) => {
    const gate = await prLive(34, admin, member, later);
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
