// SHO-US-12.6 Pipeline board (APL-2542), AC2 and AC3: the column counts and per-currency sums.
// A Super Admin's board counts every deal in the org, so another shard's deals change these numbers mid-test.
// This file is in the workflow's SERIAL_SPECS; the other ACs are in APL-2542.spec.ts and run in the shards.
import { test, expect } from "../support";
import { dealsOf, makeDeal, pipelines } from "../helpers/deal-board";

test("AC2: a person only sees and counts deals they belong to, and an archived deal is not on the board", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  const d = await makeDeal(admin, later, { label: "hidden" });
  const memberDeals = async (extra = "") => dealsOf(member.api, d.pipe.id, extra);
  expect((await memberDeals()).some((x) => x.id === d.id), "not a member, so not in the list the board counts").toBe(false);
  expect((await dealsOf(admin.api, d.pipe.id)).some((x) => x.id === d.id)).toBe(true);

  await member.page.goto("/deals");
  await expect(member.page.getByRole("region", { name: "Lead" })).toBeVisible();
  await expect(member.page.getByText(d.name)).toHaveCount(0);
  const memberLead = (await memberDeals()).filter((x) => x.stage?.name === "Lead");
  await expect(member.page.getByRole("region", { name: "Lead" }).locator("header .chip")).toHaveText(String(memberLead.length));

  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dcard", { hasText: d.name })).toBeVisible();
  const adminLead = (await dealsOf(admin.api, d.pipe.id)).filter((x) => x.stage?.name === "Lead");
  await expect(admin.page.getByRole("region", { name: "Lead" }).locator("header .chip")).toHaveText(String(adminLead.length));

  expect((await admin.api.post(`/api/projects/${d.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect((await memberDeals()).some((x) => x.id === d.id)).toBe(true);
  await member.page.reload();
  await expect(member.page.locator(".dcard", { hasText: d.name })).toBeVisible();

  expect((await admin.api.post(`/api/projects/${d.id}/archive`)).status).toBeLessThan(300);
  expect((await dealsOf(admin.api, d.pipe.id)).some((x) => x.id === d.id)).toBe(false);
  expect((await dealsOf(admin.api, d.pipe.id, "&archived=true")).some((x) => x.id === d.id)).toBe(true);
  await admin.page.reload();
  await expect(admin.page.locator(".dcard", { hasText: d.name })).toHaveCount(0);
  await member.page.reload();
  await expect(member.page.locator(".dcard", { hasText: d.name })).toHaveCount(0);
});

test("AC3: each column shows its count, the sum of known values per currency, and how many have no value", async ({ admin, later }) => {
  test.setTimeout(120_000);
  await makeDeal(admin, later, { label: "inr", value: 1000, currency: "INR" });
  await makeDeal(admin, later, { label: "usd", value: 50, currency: "USD" });
  const unknown = await makeDeal(admin, later, { label: "unknown" });
  const pipes = await pipelines(admin.api);
  await admin.page.setViewportSize({ width: 1400, height: 900 });
  await admin.page.goto("/deals");
  await expect(admin.page.getByRole("region", { name: "Lead" })).toBeVisible();
  // Read the list the board just rendered, so the header is checked against the same deals.
  const deals = await dealsOf(admin.api, pipes.pro.id);
  const row = deals.find((d) => d.id === unknown.id)!;
  expect(row.value, "unknown stays null and is never stored as zero").toBeNull();

  const isTail = (c: string) => c === "PAUSED" || c === "DONE" || c === "LOST";
  const cols = pipes.pro.stages.filter((s) => !isTail(s.category)).map((s) => ({ title: s.name, ids: [s.id] }));
  const tail = pipes.pro.stages.filter((s) => isTail(s.category));
  cols.push({ title: tail.map((s) => s.name).join(" / "), ids: tail.map((s) => s.id) });

  for (const col of cols) {
    const here = deals.filter((d) => d.stage && col.ids.includes(d.stage.id));
    for (const d of here) if (d.value !== null && d.currency) expect(d.value).toBeGreaterThan(0);
    // Format with the browser's en-IN so the string matches the header the page renders.
    const text = await admin.page.evaluate((rows: { value: number | null; currency: string | null }[]) => {
      const byCurrency = new Map<string, number>();
      let unknown = 0;
      for (const d of rows) {
        if (d.value === null || !d.currency) unknown++;
        else byCurrency.set(d.currency, (byCurrency.get(d.currency) ?? 0) + d.value);
      }
      const parts = [...byCurrency].map(([c, v]) => `${c} ${v.toLocaleString("en-IN")}`);
      return `${parts.length ? parts.join(" · ") : "No values"}${unknown ? ` · ${unknown} without value` : ""}`;
    }, here.map((d) => ({ value: d.value, currency: d.currency })));
    const region = admin.page.getByRole("region", { name: col.title });
    await expect(region.locator("header .chip")).toHaveText(String(here.length));
    await expect(region.locator("header .sub2")).toHaveText(text);
  }
});
