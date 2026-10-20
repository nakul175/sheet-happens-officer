// [SHO-US-9.2] Cost controls and caps (Linear APL-2519, PR #34). AC6 is the remaining work.
// Given the Super Admin opens Usage, when the month's spend is recorded, the screen shows spend to date,
// the monthly ceiling and the percentage used.
// AC6 v1.2 (Linear, Michael 19 Oct 2026 20:43 IST; supersedes the AC6 clarification and the v1.1 note): the percentage is
// the nearest whole number, halves up (10 of 80 shows 13%). Zero spend shows 0%. Any nonzero share under 1% shows "<1%".
// A ceiling of 0 or unset shows "No ceiling set" and no percentage. Spend over the ceiling shows the rounded percentage
// (100.40 of 100 shows 100%) plus a visible "Over ceiling" flag. The stub keeps sending the old one-decimal figure.
// A Member and an Admin are refused. The page does not request /api/usage for them, and no figures are shown.
// Widths 320, 390 and 1280 keep the spend labels fully on screen, with no sideways scroll.
// Those checks run when PR #34 is live (tests/e2e/helpers/jim-gate.ts: release SHA, then the heading in the served page)
// and skip otherwise. The fixed payloads are answered in the browser, so no usage row is written.
// The plain Member (SHO_MEMBER_*) is promoted to Admin for that one check and put back afterwards.
import { test, expect, login } from "../support";
import { notLive, prLive } from "../helpers/jim-gate";
import { CHAT, apiPercent, expectRefused, expectSpend, figure, fits, percentLabel, sampleUsage, stubUsage, usd, usageCard } from "../helpers/usage-screen";

const WHY = "the Usage screen still shows calls, tokens and cost, and does not show spend against the monthly ceiling.";
const WIDTHS = [320, 390, 1280] as const;

test.describe("SHO-US-9.2 / APL-2519", () => {
  test.describe.configure({ timeout: 120_000 });
  // AC6 v1.2 (Linear APL-2519, Michael 19 Oct 2026 20:43 IST) fails, never skips, when the screen is missing.
  // The PR #34 gate only records which build was under test.
  test("qa:TC missing AC6 v1.2: the Super Admin sees spend to date, the monthly ceiling and the percentage used from /api/usage", async ({ admin, later }) => {
    await prLive(34, admin, null, later);
    const live = await admin.api.get("/api/usage");
    const body = JSON.stringify(live.json);
    const pass = login("ADMIN").password;
    expect(live.status, "GET /api/usage").toBe(200);
    expect(body.includes(pass)).toBe(false);
    expect(body.includes(CHAT)).toBe(false);
    const ceiling = live.json.ceiling as { usd?: number | null; spendUsd: number };
    expect(typeof ceiling.spendUsd).toBe("number");

    await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
    const main = admin.page.getByRole("main");
    await expectSpend(main, ceiling.spendUsd, ceiling.usd, percentLabel(ceiling.spendUsd, ceiling.usd));
    const text = await main.innerText();
    expect(text.includes(pass)).toBe(false);
    expect(text.includes(CHAT)).toBe(false);
  });

  // Pam's AC6 cases (Linear APL-2519, 18 Oct 2026). Each label is written out, not worked out. The stub still sends the old
  // one-decimal ceiling.percent, so a screen that echoes it fails.
  const CASES: { title: string; rows: { spend: number; cap: number | null | undefined; label: string | null }[] }[] = [
    { title: "qa:TC-US92-753859f9@v2 AC6 v1.2: half rounds up, 10 of 80 shows 13%", rows: [
      { spend: 10, cap: 80, label: "13%" },
      { spend: 12.5, cap: 100, label: "13%" },
      { spend: 12.49, cap: 100, label: "12%" },
    ] },
    { title: "qa:TC-US92-b0d3b0cc@v2 AC6 v1.2: zero spend shows 0%", rows: [
      { spend: 0, cap: 100, label: "0%" },
    ] },
    { title: "qa:TC-US92-b81e727e@v2 AC6 v1.2: a nonzero share below 1%, including 0.5% to under 1%, shows <1%", rows: [
      { spend: 0.01, cap: 100, label: "<1%" },
      { spend: 0.49, cap: 100, label: "<1%" },
      { spend: 0.5, cap: 100, label: "<1%" },
      { spend: 0.99, cap: 100, label: "<1%" },
      { spend: 1, cap: 100, label: "1%" },
    ] },
    { title: "qa:TC-US92-00534b06@v2 AC6 v1.2: 50%, 99% and 100%, with no Over ceiling flag at exactly the ceiling", rows: [
      { spend: 50.03, cap: 100, label: "50%" },
      { spend: 99.49, cap: 100, label: "99%" },
      { spend: 99.5, cap: 100, label: "100%" },
      { spend: 100, cap: 100, label: "100%" },
    ] },
    { title: "qa:TC-US92-cd463d7f@v2 AC6 v1.2: well over the ceiling shows the rounded percentage plus Over ceiling", rows: [
      { spend: 113, cap: 100, label: "113%" },
      { spend: 100.5, cap: 100, label: "101%" },
      { spend: 250, cap: 100, label: "250%" },
    ] },
    { title: "qa:TC-US92-5acadabc@v1 AC6 v1.2: just over the ceiling shows 100% plus Over ceiling", rows: [
      { spend: 100.4, cap: 100, label: "100%" },
      { spend: 100.01, cap: 100, label: "100%" },
    ] },
    { title: "qa:TC-US92-30f41089@v1 AC6 v1.2: a ceiling of 0 or unset shows No ceiling set and no percentage", rows: [
      { spend: 10, cap: 0, label: null },
      { spend: 10, cap: null, label: null },
      { spend: 10, cap: undefined, label: null },
      { spend: 0, cap: 0, label: null },
    ] },
  ];

  for (const c of CASES) {
    test(c.title, async ({ admin, later }) => {
      await prLive(34, admin, null, later);
      const main = admin.page.getByRole("main");
      for (const [i, row] of c.rows.entries()) {
        const what = `${usd(row.spend)} of ${row.cap === undefined ? "no ceiling field" : String(row.cap)}`;
        expect(percentLabel(row.spend, row.cap), `oracle for ${what}`).toBe(row.label);
        // An unset ceiling leaves `usd` out of the payload; null and 0 send it.
        const ceiling = { spendUsd: row.spend, percent: apiPercent(row.spend, row.cap), ...(row.cap === undefined ? {} : { usd: row.cap }) };
        if (i > 0) await admin.page.unrouteAll({ behavior: "ignoreErrors" });
        await stubUsage(admin.page, sampleUsage({ ceiling, people: [] }));
        if (i === 0) await admin.page.goto("/usage", { waitUntil: "domcontentloaded" });
        else await admin.page.reload({ waitUntil: "domcontentloaded" });
        await test.step(what, () => expectSpend(main, row.spend, row.cap, row.label));
        await expect(main).not.toContainText(CHAT);
      }
    });
  }

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
