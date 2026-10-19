// SHO-US-14.4 First-run orientation (Linear APL-2563).
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing. An AC number is not a TC id.
// The start guide is shown once per account. Each test signs in a new Member, so the guide is still there until AC2 dismisses that account.
import { expect, zz, BASE_URL, type Json } from "../support";
import { test } from "../helpers/story-people";
import { QA_PASS, storyGate } from "../helpers/qa-alias";
import { rowAround } from "../helpers/locate";

storyGate({ admin: true, id: "APL-2563" });

type Who = { api: import("../support").Api; user: Json; page: import("@playwright/test").Page };

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
// qa:TC missing
test("AC4: a person with no projects sees the Leaders by name and a Request to be added that tells the Leader qa:TC missing", async ({ admin, member, later }) => {
  await member.page.goto("/projects");
  await expect(member.page.getByText("Ask a project Leader to add you.")).toBeVisible();
  const p = await ledProject(admin, later, "14.4 leader");
  await member.page.reload();
  const list = member.page.getByLabel("Leaders");
  await expect(list).toBeVisible();
  const showAll = list.getByRole("button", { name: /^Show all/ });
  if (await showAll.count()) await showAll.click(); // only the first six Leaders are listed until "Show all"
  const row = rowAround(list, admin.user.name as string, 2);
  await expect(row).toBeVisible();
  // Leaders are listed by name only: no project names leak to someone who is not in the project.
  await expect(list.getByText(p.name)).toHaveCount(0);
  await row.getByRole("button", { name: "Request to be added" }).click();
  await expect(row.getByText("Asked. They have been told.")).toBeVisible();
  const n = await admin.api.get("/api/notifications");
  expect(JSON.stringify(n.json)).toContain(`${member.user.name} asked to be added`); // this Member's request, not another shard's
});

// qa:TC missing
test("AC1: first sign-in shows the start guide above everything else on My tasks qa:TC missing", async ({ member }) => {
  expect(await guideShown(member), "a new account has not dismissed the start guide").toBe(true);
  const page = member.page;
  await page.goto("/");
  const guide = page.getByRole("region", { name: "Start guide" });
  await expect(guide).toBeVisible();
  const below = await guide.evaluate((el) => {
    const main = el.closest("main");
    if (!main) return ["no main"];
    const top = el.getBoundingClientRect().y;
    return [...main.children]
      .filter((child) => child !== el && child.querySelector("h1") === null && child.getBoundingClientRect().height > 0 && child.getBoundingClientRect().y < top)
      .map((child) => (child.getAttribute("aria-label") || child.textContent || "").slice(0, 40));
  });
  expect(below, "the guide sits above every other block on My tasks").toEqual([]);
});

// qa:TC missing
test("AC5: the guide has at most 3 items and fits above the fold at 1440 by 900 qa:TC missing", async ({ member }) => {
  expect(await guideShown(member), "a new account has not dismissed the start guide").toBe(true);
  const page = member.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const guide = page.getByRole("region", { name: "Start guide" });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole("listitem")).toHaveCount(3);
  const box = (await guide.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(900);
});
// qa:TC missing
test("AC2: Dismiss removes the guide for good, also on another device qa:TC missing", async ({ member, browser }) => {
  expect(await guideShown(member), "a new account has not dismissed the start guide").toBe(true);
  const page = member.page;
  await page.goto("/");
  const saved = page.waitForResponse((r) => r.url().includes("/api/profile/start-guide") && r.request().method() === "POST" && r.ok());
  await page.getByRole("region", { name: "Start guide" }).getByRole("button", { name: "Dismiss" }).click();
  await saved;
  await expect(page.getByRole("region", { name: "Start guide" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Start guide" })).toHaveCount(0);
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
  });
  const r = await ctx.request.post("/api/auth/signin", { data: { email: member.user.email, password: QA_PASS } });
  expect(r.ok()).toBe(true);
  const other = await ctx.newPage();
  await other.goto("/");
  await expect(other.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await expect(other.getByRole("region", { name: "Start guide" })).toHaveCount(0);
  await ctx.close();
});

// qa:TC missing
test("AC3: Team shows each person's organisation role and the projects they lead qa:TC missing", async ({ admin, member, later }) => {
  const p = await ledProject(admin, later, "14.4 team", [member as unknown as Who]);
  for (const who of [admin, member]) {
    await who.page.goto("/team");
    const lead = who.page.getByRole("main").getByRole("link", { name: p.name, exact: true });
    await expect(lead, "the led project is listed against its Leader").toBeVisible();
    await expect(lead).toHaveText(p.name);
    // The inner link is searched inside the row. A page-level link would look for main inside the row and match nothing.
    const tableRow = who.page.getByRole("main").getByRole("row").filter({ has: who.page.getByRole("link", { name: p.name, exact: true }) });
    const row = (await tableRow.count()) > 0 ? tableRow : lead.locator("xpath=ancestor::div[1]");
    await expect(row.getByText("Super Admin", { exact: true })).toHaveCount(1);
  }
});

