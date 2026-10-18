// SHO-US-14.12 Density and visual hierarchy (APL-2571).
import { test, expect, zz } from "../support";

test.use({ viewport: { width: 1440, height: 900 } });

async function listProject(admin: any, later: any, n: number) {
  const r = await admin.api.post("/api/projects", { name: zz("density"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  for (let i = 0; i < n; i++) {
    const t = await admin.api.post(`/api/projects/${id}/tasks`, { title: `${zz("row")} ${String(i).padStart(2, "0")}`, assigneeId: admin.user.id, priority: "HIGH", dueDate: "2030-01-0" + ((i % 9) + 1) });
    expect(t.status).toBe(201);
  }
  return id;
}

test("AC1: Compact shows at least 16 rows at 1440 by 900 and the setting persists per person", async ({ admin, later }) => {
  later(() => admin.api.put("/api/profile/density", { compact: false })); // leave the shared account as it was
  await admin.api.put("/api/profile/density", { compact: false });
  const id = await listProject(admin, later, 20);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  const visibleRows = () => p.evaluate(() => [...document.querySelectorAll("main.content .item")].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight; }).length);
  await expect(p.getByText(`${zz("row")} 00`).first()).toBeVisible();
  const comfortable = await visibleRows();
  await p.getByRole("button", { name: /Compact/ }).click();
  await expect(p.getByRole("button", { name: /Compact/ })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(visibleRows).toBeGreaterThanOrEqual(16);
  expect(await visibleRows()).toBeGreaterThan(comfortable);
  await expect.poll(async () => (await admin.api.get("/api/profile/density")).json).toEqual({ compact: true }); // saved on the person
  await p.reload();
  await expect(p.getByRole("button", { name: /Compact/ })).toHaveAttribute("aria-pressed", "true");
});

test("AC2: metadata is not link-coloured; only the title is interactive", async ({ admin, later }) => {
  const id = await listProject(admin, later, 3);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  const row = p.locator("main.content .item").filter({ hasText: `${zz("row")} 00` }).first();
  await expect(row).toBeVisible();
  const info = await row.evaluate((el) => {
    const meta = el.querySelector(".meta");
    const anchors = meta ? [...meta.querySelectorAll("a")].length : 0;
    const link = document.querySelector("main.content a, nav a");
    const linkColor = link ? getComputedStyle(link).color : "";
    const metaColors = meta ? [...meta.querySelectorAll("*")].map((n) => getComputedStyle(n).color) : [];
    return { anchors, linkColor, metaColors, hasMeta: !!meta };
  });
  expect(info.hasMeta).toBe(true);
  expect(info.anchors).toBe(0); // priority and assignee are not links
  const linkColor = info.linkColor;
  // none of the metadata uses the colour the app gives to links
  if (linkColor) expect(info.metaColors.some((c) => c === linkColor)).toBe(false);
});

test("AC3: hiding the concierge dock frees the width and the concierge stays reachable from a labelled button", async ({ admin, later }) => {
  const id = await listProject(admin, later, 3);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  const dock = p.locator("aside.cc-slot");
  const width = () => p.locator("main.content").first().evaluate((el) => el.getBoundingClientRect().width);
  await expect(dock).toBeVisible();
  const before = await width();
  await dock.getByRole("button", { name: "Hide" }).click();
  await expect(dock).toHaveCount(0);
  expect(await width()).toBeGreaterThan(before);
  const btn = p.getByRole("button", { name: /^Concierge/ }).first();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(p.locator("aside.cc-slot")).toBeVisible();
});

test.skip("AC4: contrast of every text and icon is at least 4.5:1 (3:1 for large text and icons)", async () => {
  // A full contrast audit needs an axe/colour-contrast pass over real data on every row state; the repo's axe suite
  // (tests/viewport/a11y.test.ts) does that against a local test database. It is not repeated here against staging.
});
