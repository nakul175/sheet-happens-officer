// SHO-US-14.13 Notification triage (APL-2572). Needs the optional Member account (it receives the notices).
// The file skips only when SHO_QA_PASS is unset. AC3 always checks the Unread tab (APL-2672 is on main).
import { test, expect, zz, type Later, type Page, type Who } from "../support";
import { PASS, passwordOk } from "./qa";

// Pam has not published a TC hash. The marker is the literal "qa:TC missing".
const tag = (id: string) => ({ annotation: [{ type: "ac", description: id }, { type: "qa:TC", description: "qa:TC missing" }] });

test.beforeAll(() => {
  test.skip(!PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
});

async function give(admin: Who, member: Who, later: Later, n: number, label: string) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  for (let i = 0; i < n; i++) expect((await admin.api.post(`/api/projects/${id}/tasks`, { title: `${zz(label)} ${i}`, assigneeId: member.user.id })).status).toBe(201);
  return id;
}
const unread = async (member: Who) => (await member.api.get("/api/notifications")).json.unread as number;
const bell = (p: Page) => p.getByRole("button", { name: /^Notifications/ });

test("AC1: opening the bell leaves 5 unread items unread and the badge stays", tag("APL-2572 AC1"), async ({ admin, member, later }) => {
  await give(admin, member, later, 5, "triage-open");
  const before = await unread(member);
  expect(before).toBeGreaterThanOrEqual(5);
  const p = member.page;
  await p.goto("/");
  await expect(bell(p)).toHaveAttribute("aria-label", `Notifications, ${before > 99 ? "99+" : before} unread`);
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  const row = panel.getByRole("link", { name: `${zz("triage-open")} 0` });
  await expect(row).toBeVisible();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect.poll(() => unread(member)).toBe(before);
  await expect(bell(p)).toHaveAttribute("aria-label", `Notifications, ${before > 99 ? "99+" : before} unread`);
});

test("AC2: clicking an item opens its task and marks it read", tag("APL-2572 AC2"), async ({ admin, member, later }) => {
  await give(admin, member, later, 1, "triage-click");
  const before = await unread(member);
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  await p.getByRole("dialog", { name: "Notifications" }).getByRole("link", { name: `${zz("triage-click")} 0` }).click();
  await expect(p).toHaveURL(/task=|\/projects\//);
  await expect.poll(() => unread(member)).toBe(before - 1);
});

test("AC3: the Unread filter hides read items, and an empty result says 'All caught up'", tag("APL-2572 AC3"), async ({ admin, member, later }) => {
  test.setTimeout(120_000);
  await give(admin, member, later, 2, "triage-filter");
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  await panel.getByRole("button", { name: `${zz("triage-filter")} 0` }).click();
  await panel.getByRole("button", { name: /^Unread/ }).click();
  expect((await member.api.get("/api/notifications?filter=unread")).json.items.every((n: { read: boolean }) => !n.read)).toBe(true);
  await expect.poll(async () => (await panel.getByRole("link").count()) - (await panel.getByRole("img", { name: "Unread" }).count())).toBe(0);
  expect((await member.api.post("/api/notifications/read-all")).status).toBeLessThan(300);
  await p.reload();
  await bell(p).click();
  await p.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: /^Unread/ }).click();
  const panel2 = p.getByRole("dialog", { name: "Notifications" });
  // If someone else's activity raised a new notice in the meantime, the filter must still show unread items only.
  if ((await unread(member)) === 0) await expect(panel2.getByText("All caught up")).toBeVisible();
  else await expect.poll(async () => (await panel2.getByRole("link").count()) - (await panel2.getByRole("img", { name: "Unread" }).count())).toBe(0);
});

test("AC4: marking an item unread raises the badge by 1", tag("APL-2572 AC4"), async ({ admin, member, later }) => {
  await give(admin, member, later, 1, "triage-unread");
  expect((await member.api.post("/api/notifications/read-all")).status).toBeLessThan(300);
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  await panel.getByRole("button", { name: `${zz("triage-unread")} 0` }).click();
  await expect(bell(p)).toHaveAttribute("aria-label", /1 unread/);
  expect(await unread(member)).toBe(1);
});

test("AC5: with more than 50 items, older ones load on request", tag("APL-2572 AC5"), async ({ admin, member, later }) => {
  test.setTimeout(240_000);
  await give(admin, member, later, 52, "triage-page");
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  await expect(panel.getByRole("link")).toHaveCount(50);
  await panel.getByRole("button", { name: /Load older/ }).click();
  await expect.poll(() => panel.getByRole("link").count()).toBeGreaterThan(50);
});
