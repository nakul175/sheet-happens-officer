// [SHO-US-9.2] Cost controls and caps (Linear APL-2519, PR #34). AC6 is the remaining work.
// Given the Super Admin opens Usage, when the month's spend is recorded, the screen shows spend to date,
// the monthly ceiling and the percentage used.
// The percentage is the nearest whole number, and a half goes up. 10 of 80 (12.5) shows 13%.
// Zero spend shows 0%. Any nonzero share under 1% shows <1%, before rounding. Over 100% shows the
// real rounded figure, uncapped (120 stays 120%, and 119.5 becomes 120%).
// PR #34 still prints the one-decimal ceiling.percent, so 10 of 80 shows 12.5% there. These expects
// fail until that screen is updated. The stub keeps sending that one-decimal figure.
// A Member and an Admin are refused. The page does not request /api/usage for them, and no figures are shown.
// Widths 320, 390 and 1280 keep the spend labels fully on screen, with no sideways scroll.
// Those checks run when PR #34 is live (tests/e2e/helpers/jim-gate.ts: release SHA, then the heading in the served page)
// and skip otherwise. The fixed payloads are answered in the browser, so no usage row is written.
// The plain Member (SHO_MEMBER_*) is promoted to Admin for that one check and put back afterwards.
import { test, expect, login } from "../support";
import { notLive, prLive } from "../helpers/jim-gate";
import { CHAT, apiPercent, expectRefused, figure, fits, percentLabel, sampleUsage, stubUsage, usd, usageCard } from "../helpers/usage-screen";

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
    const label = percentLabel(ceiling.spendUsd, ceiling.usd);

    await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
    const card = usageCard(admin.page, "Spend against the monthly ceiling");
    await expect(card.getByRole("heading", { name: "Spend against the monthly ceiling" })).toBeVisible();
    await expect(figure(card, "Spend to date")).toHaveText(usd(ceiling.spendUsd));
    await expect(figure(card, "Monthly ceiling")).toHaveText(usd(ceiling.usd));
    await expect(figure(card, "Percentage used")).toHaveText(label);
    const meter = admin.page.getByRole("meter", { name: "Spend against the monthly ceiling" });
    await expect(meter).toHaveAttribute("aria-valuetext", `${usd(ceiling.spendUsd)} of ${usd(ceiling.usd)}, ${label} used`);
    const main = await admin.page.locator("main").innerText();
    expect(main.includes(pass)).toBe(false);
    expect(main.includes(CHAT)).toBe(false);
  });

  test("AC6: the percentage is the nearest whole number, halves up, including under 1% and over 100%", async ({ admin, later }) => {
    const gate = await prLive(34, admin, null, later);
    test.skip(!gate.deployed, notLive(gate, WHY));
    // Each label is the BA rule, not the one-decimal figure the stub still sends.
    // 0 is 0%. Just under 1% (including 0.5, which would otherwise round to 1) is <1%. Exactly 1% is 1%.
    // 12.5 halves up to 13, and 12.4 goes to 12. Over 100% stays the real figure: 120, 112.4 to 112, 119.5 to 120.
    const cases: { spend: number; cap: number; label: string }[] = [
      { spend: 0, cap: 80, label: "0%" },
      { spend: 1, cap: 200, label: "<1%" },
      { spend: 1, cap: 1000, label: "<1%" },
      { spend: 1, cap: 101, label: "<1%" },
      { spend: 1, cap: 100, label: "1%" },
      { spend: 10, cap: 80, label: "13%" },
      { spend: 124, cap: 1000, label: "12%" },
      { spend: 120, cap: 100, label: "120%" },
      { spend: 112.4, cap: 100, label: "112%" },
      { spend: 239, cap: 200, label: "120%" },
    ];
    for (const [i, row] of cases.entries()) {
      expect(percentLabel(row.spend, row.cap), `${row.spend} of ${row.cap}`).toBe(row.label);
      if (i > 0) await admin.page.unrouteAll({ behavior: "ignoreErrors" });
      await stubUsage(admin.page, sampleUsage({
        ceiling: { usd: row.cap, spendUsd: row.spend, percent: apiPercent(row.spend, row.cap) },
        people: [],
      }));
      if (i === 0) await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
      else await admin.page.reload({ waitUntil: "domcontentloaded" });
      const card = usageCard(admin.page, "Spend against the monthly ceiling");
      await expect(figure(card, "Spend to date")).toHaveText(usd(row.spend));
      await expect(figure(card, "Monthly ceiling")).toHaveText(usd(row.cap));
      await expect(figure(card, "Percentage used"), `${usd(row.spend)} of ${usd(row.cap)}`).toHaveText(row.label);
      await expect(admin.page.getByRole("meter", { name: "Spend against the monthly ceiling" }))
        .toHaveAttribute("aria-valuetext", `${usd(row.spend)} of ${usd(row.cap)}, ${row.label} used`);
      expect(await admin.page.locator("main").innerText()).not.toContain(CHAT);
    }
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
