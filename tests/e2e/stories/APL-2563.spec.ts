// SHO-US-14.4 First-run orientation (Linear APL-2563).
// The start guide is shown once per account. A spec can only see it on an account that has not dismissed it yet, so AC1, AC2 and AC5
// skip with a reason when the Member account has already dismissed it (dismissing is permanent for that account, by design).
import { test, expect, zz } from "../support";

type Who = { api: import("../support").Api; user: Record<string, any>; page: import("@playwright/test").Page };

async function ledProject(admin: Who, later: (f: () => Promise<unknown>) => void, label: string, members: Who[] = []) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const pid = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  for (const m of members) expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: m.user.id, role: "EDITOR" })).status).toBe(201);
  return { pid, name: zz(label) };
}

async function guideShown(member: Who) {
  const me = await member.api.get("/api/auth/me");
  return !!me.json.user?.startGuide;
}

// Order matters: AC2 dismisses the guide and AC3 adds the Member to a project, so the checks that need a fresh account run first.
test("AC4: a person with no projects sees the Leaders by name and a Request to be added that tells the Leader", async ({ admin, member, later }) => {
  await member.page.goto("/projects");
  const empty = await member.page.getByText("Ask a project Leader to add you.").waitFor({ timeout: 6000 }).then(() => 1, () => 0);
  test.skip(empty === 0, "The Member account already belongs to projects, so the empty Projects screen is not shown. Use a Member with no projects.");
  const p = await ledProject(admin, later, "14.4 leader");
  await member.page.reload();
  const list = member.page.getByLabel("Leaders");
  await expect(list).toBeVisible();
  const showAll = list.getByRole("button", { name: /^Show all/ });
  if (await showAll.count()) await showAll.click(); // only the first six Leaders are listed until "Show all"
  const row = list.locator(".item", { hasText: admin.user.name }).first();
  await expect(row).toBeVisible();
  // Leaders are listed by name only: no project names leak to someone who is not in the project.
  await expect(list.getByText(p.name)).toHaveCount(0);
  await row.getByRole("button", { name: "Request to be added" }).click();
  await expect(row.getByText("Asked. They have been told.")).toBeVisible();
  const n = await admin.api.get("/api/notifications");
  expect(JSON.stringify(n.json)).toContain("asked to be added");
});

test("AC1: first sign-in shows the start guide above everything else on My tasks", async ({ member }) => {
  test.skip(!(await guideShown(member)), "The Member account has already dismissed its start guide. Use an account that has never dismissed it.");
  const page = member.page;
  await page.goto("/");
  const guide = page.getByRole("region", { name: "Start guide" });
  await expect(guide).toBeVisible();
  const guideTop = (await guide.boundingBox())!.y;
  for (const other of await page.locator("main .list, main .grp, main .card, main .item").all()) {
    const box = await other.boundingBox();
    if (box) expect(guideTop, "the guide sits above every task group").toBeLessThanOrEqual(box.y);
  }
});

test("AC5: the guide has at most 3 items and fits above the fold at 1440 by 900", async ({ member }) => {
  test.skip(!(await guideShown(member)), "The Member account has already dismissed its start guide. Use an account that has never dismissed it.");
  const page = member.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const guide = page.getByRole("region", { name: "Start guide" });
  await expect(guide).toBeVisible();
  await expect(guide.locator("ol > li")).toHaveCount(3);
  const box = (await guide.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(900);
});
test("AC2: Dismiss removes the guide for good, also on another device", async ({ member, anon }) => {
  test.skip(!(await guideShown(member)), "The Member account has already dismissed its start guide. Use an account that has never dismissed it.");
  const page = member.page;
  await page.goto("/");
  await page.getByRole("region", { name: "Start guide" }).getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("region", { name: "Start guide" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Start guide" })).toHaveCount(0);
  // A second browser with its own cookies: a different "device".
  const r = await anon.context().request.post("/api/auth/signin", { data: { email: process.env.SHO_MEMBER_EMAIL, password: process.env.SHO_MEMBER_PASS } });
  expect(r.ok()).toBe(true);
  await anon.goto("/");
  await expect(anon.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await expect(anon.getByRole("region", { name: "Start guide" })).toHaveCount(0);
});

test("AC3: Team shows each person's organisation role and the projects they lead", async ({ admin, member, later }) => {
  const p = await ledProject(admin, later, "14.4 team", [member as unknown as Who]);
  for (const who of [admin, member]) {
    await who.page.goto("/team");
    const lead = who.page.locator(`a[href="/projects/${p.pid}"]`).first();
    await expect(lead, "the led project is listed against its Leader").toBeVisible();
    await expect(lead).toHaveText(p.name);
    const row = who.page.locator("tr, .item").filter({ has: who.page.locator(`a[href="/projects/${p.pid}"]`) }).first();
    await expect(row.getByText("Super Admin")).toBeVisible(); // the organisation role of the Leader
  }
});

