// SHO-US-14.13 Notification triage (APL-2572). Needs the optional Member account (it receives the notices).
// AC3 runs whenever PR #23 is live (tests/e2e/helpers/jim-gate.ts) and skips otherwise: until then the Unread tab can list read rows.
import { test, expect, zz } from "../support";
import { notLive, prLive } from "../helpers/jim-gate";

async function give(admin: any, member: any, later: any, n: number) {
  const r = await admin.api.post("/api/projects", { name: zz("bell"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  for (let i = 0; i < n; i++) expect((await admin.api.post(`/api/projects/${id}/tasks`, { title: `${zz("note")} ${i}`, assigneeId: member.user.id })).status).toBe(201);
  return id;
}
const unread = async (member: any) => (await member.api.get("/api/notifications")).json.unread as number;
const bell = (p: any) => p.getByRole("button", { name: /^Notifications/ });

test("AC1: opening the bell leaves 5 unread items unread and the badge stays", async ({ admin, member, later }) => {
  await give(admin, member, later, 5);
  const before = await unread(member);
  expect(before).toBeGreaterThanOrEqual(5);
  const p = member.page;
  await p.goto("/");
  await expect(bell(p)).toHaveAttribute("aria-label", new RegExp(`${before} unread`));
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  await expect(panel.getByText(`${zz("note")} 0`).first()).toBeVisible();
  await expect(panel.locator(".bell-dot").first()).toBeVisible();
  await p.waitForTimeout(800);
  expect(await unread(member)).toBe(before);
  await expect(bell(p)).toHaveAttribute("aria-label", new RegExp(`${before} unread`));
});

test("AC2: clicking an item opens its task and marks it read", async ({ admin, member, later }) => {
  await give(admin, member, later, 1);
  const before = await unread(member);
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  await p.getByRole("dialog", { name: "Notifications" }).getByRole("link", { name: new RegExp(zz("note")) }).first().click();
  await expect(p).toHaveURL(/task=|\/projects\//);
  await expect.poll(() => unread(member)).toBe(before - 1);
});

test("AC3: the Unread filter hides read items, and an empty result says 'All caught up'", async ({ admin, member, later }) => {
  test.setTimeout(120_000);
  const gate = await prLive(23, admin, null, later);
  test.skip(!gate.deployed, notLive(gate, "the Unread tab can still list read rows."));
  await give(admin, member, later, 2);
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  await panel.getByRole("button", { name: /^Mark as read: / }).first().click();
  await panel.getByRole("button", { name: /^Unread/ }).click();
  expect((await member.api.get("/api/notifications?filter=unread")).json.items.every((n: { read: boolean }) => !n.read)).toBe(true);
  await expect(panel.locator(".bell-row:not(.unread)")).toHaveCount(0);
  expect((await member.api.post("/api/notifications/read-all")).status).toBeLessThan(300);
  await p.reload();
  await bell(p).click();
  await p.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: /^Unread/ }).click();
  const panel2 = p.getByRole("dialog", { name: "Notifications" });
  // If someone else's activity raised a new notice in the meantime, the filter must still show unread items only.
  if ((await unread(member)) === 0) await expect(panel2.getByText("All caught up")).toBeVisible();
  else await expect(panel2.locator(".bell-row:not(.unread)")).toHaveCount(0);
});

test("AC4: marking an item unread raises the badge by 1", async ({ admin, member, later }) => {
  await give(admin, member, later, 1);
  expect((await member.api.post("/api/notifications/read-all")).status).toBeLessThan(300);
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  await panel.getByRole("button", { name: /^Mark as unread/ }).first().click();
  await expect(bell(p)).toHaveAttribute("aria-label", /1 unread/);
  expect(await unread(member)).toBe(1);
});

test("AC5: with more than 50 items, older ones load on request", async ({ admin, member, later }) => {
  test.setTimeout(240_000);
  await give(admin, member, later, 52);
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  await expect(panel.locator(".bell-row")).toHaveCount(50);
  await panel.getByRole("button", { name: /Load older/ }).click();
  await expect.poll(() => panel.locator(".bell-row").count()).toBeGreaterThan(50);
});
