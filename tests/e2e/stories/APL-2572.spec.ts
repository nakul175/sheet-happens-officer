// SHO-US-14.13 Notification triage (APL-2572). Needs the optional Member account (it receives the notices).
// The file skips only when SHO_QA_PASS is unset. AC3 runs at desktop and phone width (APL-2672 is on main).
import { test, expect, zz, type Later, type Page, type Who } from "../support";
import { clickClear } from "../helpers/phone-hit";
import { PASS, passwordOk } from "./qa";

// Pam has not published a TC hash. The marker is the literal "qa:TC missing".
const tag = (id: string) => ({ annotation: [{ type: "ac", description: id }, { type: "qa:TC", description: "qa:TC missing" }] });

test.beforeAll(() => {
  test.skip(!PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
});

async function give(admin: Who, member: Who, later: Later, n: number) {
  const r = await admin.api.post("/api/projects", { name: zz("bell"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const titles: string[] = [];
  for (let i = 0; i < n; i++) {
    // The project id keeps this title off every other notice in the run, including "1" inside "10".
    const title = `${zz("note")} ${id} ${i}`;
    expect((await admin.api.post(`/api/projects/${id}/tasks`, { title, assigneeId: member.user.id })).status).toBe(201);
    titles.push(title);
  }
  return titles;
}
/** The bell quotes the task title in the link and in the mark button's accessible name. */
const quoted = (title: string) => `"${title}"`;
const marked = (admin: Who, read: boolean, title: string) =>
  `${read ? "Mark as unread" : "Mark as read"}: ${admin.user.name} assigned you ${quoted(title)}.`;
const unread = async (member: Who) => (await member.api.get("/api/notifications")).json.unread as number;
const bell = (p: Page) => p.getByRole("button", { name: /^Notifications/ });

test("qa:TC missing AC1: opening the bell leaves 5 unread items unread and the badge stays", tag("APL-2572 AC1"), async ({ admin, member, later }) => {
  const titles = await give(admin, member, later, 5);
  const before = await unread(member);
  expect(before).toBeGreaterThanOrEqual(5);
  const p = member.page;
  await p.goto("/");
  await expect(bell(p)).toHaveAttribute("aria-label", new RegExp(`${before} unread`));
  // Opening calls load(), which GETs /api/notifications and does not mark anything read.
  const opened = p.waitForResponse((res) => {
    if (res.request().method() !== "GET" || !res.ok()) return false;
    return new URL(res.url()).pathname === "/api/notifications";
  });
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  const note = panel.getByRole("link", { name: quoted(titles[0]) });
  await expect(note).toBeVisible();
  await expect(note.getByRole("img", { name: "Unread" })).toBeVisible();
  expect((await (await opened).json()).unread).toBe(before);
  expect(await unread(member)).toBe(before);
  await expect(bell(p)).toHaveAttribute("aria-label", new RegExp(`${before} unread`));
});

test("qa:TC missing AC2: clicking an item opens its task and marks it read", tag("APL-2572 AC2"), async ({ admin, member, later }) => {
  const titles = await give(admin, member, later, 1);
  const before = await unread(member);
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  await clickClear(p.getByRole("dialog", { name: "Notifications" }).getByRole("link", { name: quoted(titles[0]) }));
  await expect(p).toHaveURL(/task=|\/projects\//);
  await expect.poll(() => unread(member)).toBe(before - 1);
});

test("qa:TC missing AC3: the Unread filter hides read items, and an empty result says 'All caught up'", tag("APL-2572 AC3"), async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  const p = member.page;
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const titles = await give(admin, member, later, 2);
    await p.setViewportSize(viewport);
    await p.goto("/");
    await expect(bell(p)).toBeVisible();
    await bell(p).click();
    const panel = p.getByRole("dialog", { name: "Notifications" });
    const mark = panel.getByRole("button", { name: marked(admin, false, titles[0]), exact: true });
    await expect(mark).toBeVisible();
    await clickClear(mark);
    const unreadTab = panel.getByRole("button", { name: /^Unread/ });
    await expect(unreadTab).toBeVisible();
    await clickClear(unreadTab);
    await expect.poll(async () => {
      const items = (await member.api.get("/api/notifications?filter=unread")).json.items as { read: boolean }[];
      return items.every((n) => !n.read);
    }).toBe(true);
    await expect(panel.locator(".bell-row:not(.unread)")).toHaveCount(0);
    expect((await member.api.post("/api/notifications/read-all")).status).toBeLessThan(300);
    await p.reload();
    await expect(bell(p)).toBeVisible();
    await bell(p).click();
    const panel2 = p.getByRole("dialog", { name: "Notifications" });
    const unreadAgain = panel2.getByRole("button", { name: /^Unread/ });
    await expect(unreadAgain).toBeVisible();
    await clickClear(unreadAgain);
    // If someone else's activity raised a new notice in the meantime, the filter must still show unread items only.
    if ((await unread(member)) === 0) await expect(panel2.getByText("All caught up")).toBeVisible();
    else await expect(panel2.locator(".bell-row:not(.unread)")).toHaveCount(0);
    await p.keyboard.press("Escape");
  }
});

test("qa:TC missing AC4: marking an item unread raises the badge by 1", tag("APL-2572 AC4"), async ({ admin, member, later }) => {
  const titles = await give(admin, member, later, 1);
  expect((await member.api.post("/api/notifications/read-all")).status).toBeLessThan(300);
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  await clickClear(panel.getByRole("button", { name: marked(admin, true, titles[0]), exact: true }));
  await expect(bell(p)).toHaveAttribute("aria-label", /1 unread/);
  expect(await unread(member)).toBe(1);
});

test("qa:TC missing AC5: with more than 50 items, older ones load on request", tag("APL-2572 AC5"), async ({ admin, member, later }) => {
  test.setTimeout(240_000);
  await give(admin, member, later, 52);
  const p = member.page;
  await p.goto("/");
  await bell(p).click();
  const panel = p.getByRole("dialog", { name: "Notifications" });
  await expect(panel.locator(".bell-row")).toHaveCount(50);
  await clickClear(panel.getByRole("button", { name: /Load older/ }));
  await expect.poll(() => panel.locator(".bell-row").count()).toBeGreaterThan(50);
});
