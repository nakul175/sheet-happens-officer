import { archiveProject } from "../helpers/migration-2731";
import { test as qaTest, verifiedUser, deactivate, PASS } from "./qa";
// SHO-US-14.4 First-run orientation (Linear APL-2563).
// Each case gets an independent verified synthetic Member, so guide dismissal and project state never skip coverage.
import { expect, zz, type Json } from "../support";

type Who = { api: import("../support").Api; user: Json; page: import("@playwright/test").Page };
let freshMembers = 0;
const test = qaTest.extend({
  member: async ({ admin, browser, anon, later }, use) => {
    const fresh = await verifiedUser(browser, anon.context().request, "2563", `fresh${freshMembers++}`);
    later(() => fresh.ctx.close());
    later(() => deactivate(admin.api, fresh.user.id));
    await use({ page: fresh.page, api: fresh.api, user: fresh.user });
  },
});

async function ledProject(admin: Who, later: (f: () => Promise<unknown>) => void, label: string, members: Who[] = []) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const pid = r.json.project.id as string;
  later(() => archiveProject(admin.api, pid, admin.user.id));
  for (const m of members) expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: m.user.id, role: "EDITOR" })).status).toBe(201);
  return { pid, name: zz(label) };
}

async function guideShown(member: Who) {
  const me = await member.api.get("/api/auth/me");
  return !!me.json.user?.startGuide;
}

// Fresh per-case accounts keep all first-run and empty-state checks independent.
test("AC4: a person with no projects sees the Leaders by name and a Request to be added that tells the Leader", async ({ admin, member, later }) => {
  await member.page.goto("/projects");
  const empty = await member.page.getByText("Ask a project Leader to add you.").waitFor({ timeout: 6000 }).then(() => 1, () => 0);
  expect(empty, "fresh Member has no project memberships").toBe(1);
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
  expect(JSON.stringify(n.json)).toContain(`${member.user.name} asked to be added`); // this Member's request, not another shard's
});

test("AC1: first sign-in shows the start guide above everything else on My tasks", async ({ member }) => {
  expect(await guideShown(member), "fresh Member has an undismissed start guide").toBe(true);
  const page = member.page;
  await page.goto("/my-tasks");
  const guide = page.getByRole("region", { name: "Start guide" });
  await expect(guide).toBeVisible();
  const guideTop = (await guide.boundingBox())!.y;
  for (const other of await page.locator("main .list, main .grp, main .card, main .item").all()) {
    const box = await other.boundingBox();
    if (box) expect(guideTop, "the guide sits above every task group").toBeLessThanOrEqual(box.y);
  }
});

test("AC5: the guide has at most 3 items and fits above the fold at 1440 by 900", async ({ member }) => {
  expect(await guideShown(member), "fresh Member has an undismissed start guide").toBe(true);
  const page = member.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/my-tasks");
  const guide = page.getByRole("region", { name: "Start guide" });
  await expect(guide).toBeVisible();
  await expect(guide.locator("ol > li")).toHaveCount(3);
  const box = (await guide.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(900);
});
test("AC2: Dismiss removes the guide for good, also on another device", async ({ member, anon }) => {
  expect(await guideShown(member), "fresh Member has an undismissed start guide").toBe(true);
  const page = member.page;
  await page.goto("/my-tasks");
  await page.getByRole("region", { name: "Start guide" }).getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("region", { name: "Start guide" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Start guide" })).toHaveCount(0);
  // A second browser with its own cookies: a different "device".
  const r = await anon.context().request.post("/api/auth/signin", { data: { email: member.user.email, password: PASS } });
  expect(r.ok()).toBe(true);
  await anon.goto("/my-tasks");
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
