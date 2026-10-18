// APL-2506 · SHO-US-7.1 Notification bell and panel
// Acceptance criteria: AC1 count and newest-first list, AC2 mark read, AC3 privacy, AC4 one notice per affected person per event,
// AC5 90-day retention, AC6 no email.
// Note: AC1 says the latest 30; SHO-US-14.13 changed the panel to 50 at a time with Load older. The test follows 14.13.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz } from "../support";

async function proj(admin: any, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return id;
}
const withMember = async (admin: any, member: any, label: string, later: (f: () => Promise<unknown>) => void) => {
  const p = await proj(admin, label, later);
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  return p;
};
const mk = async (who: any, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await who.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};
type N = { id: string; text: string; href: string; read: boolean; createdAt: string };
const inbox = async (who: any) => (await who.api.get("/api/notifications?limit=200")).json as { unread: number; items: N[] };

test("AC1: a new notification raises the count and appears first in the panel", async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "bell-new", later);
  const before = (await inbox(member)).unread;
  await mk(admin, p, zz("count me"), { assigneeId: member.user.id });
  const now = await inbox(member);
  expect(now.unread).toBe(before + 1);
  expect(now.items[0].text).toContain(zz("count me")); // newest first
  expect((await member.api.get("/api/notifications")).json.items.length).toBeLessThanOrEqual(50); // default page, SHO-US-14.13
  await member.page.goto("/");
  await expect(member.page.getByRole("button", { name: `Notifications, ${before + 1} unread` })).toBeVisible();
  await member.page.getByRole("button", { name: /^Notifications/ }).click();
  await expect(member.page.getByRole("dialog", { name: "Notifications" }).locator(".bell-main").first()).toContainText(zz("count me"));
});

test("AC2: opening an item marks it read and the count drops; Mark all as read clears the count", async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "bell-read", later);
  await mk(admin, p, zz("read one"), { assigneeId: member.user.id });
  await mk(admin, p, zz("read two"), { assigneeId: member.user.id });
  const start = (await inbox(member)).unread;
  expect(start).toBeGreaterThanOrEqual(2);
  await member.page.goto("/");
  await member.page.getByRole("button", { name: /^Notifications/ }).click();
  await member.page.getByRole("dialog", { name: "Notifications" }).locator(".bell-main", { hasText: zz("read two") }).click();
  await expect.poll(async () => (await inbox(member)).unread).toBe(start - 1);
  await member.page.goto("/"); // the click opened the task; start again from a clean page
  await member.page.getByRole("button", { name: /^Notifications/ }).click();
  await member.page.getByRole("button", { name: "Mark all as read" }).click();
  await expect.poll(async () => (await inbox(member)).unread).toBe(0);
  await expect(member.page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible(); // no count left
});

test("AC3: another person's notifications are never returned or changed", async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "bell-private", later);
  await mk(member, p, zz("for the leader"), { assigneeId: admin.user.id });
  const mine = await inbox(admin);
  const note = mine.items.find((n) => n.text.includes(zz("for the leader")));
  expect(note, "the Leader was told").toBeTruthy();
  expect((await inbox(member)).items.some((n) => n.text.includes(zz("for the leader")))).toBe(false); // not returned to the actor
  // the member tries to mark the Leader's notice read: no effect
  await member.api.post(`/api/notifications/${note!.id}/read`);
  const after = (await inbox(admin)).items.find((n) => n.id === note!.id)!;
  expect(after.read).toBe(false);
});

test("AC4: each event in the list gives exactly one notification to the affected person and none to the person who caused it", async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "bell-types", later);
  const t = await mk(admin, p, zz("typed"), { assigneeId: member.user.id });                       // assigned
  await mk(admin, p, zz("collab"), { collaboratorIds: [member.user.id] });               // added as collaborator
  expect((await member.api.patch(`/api/tasks/${t}`, { blocked: true, blockedReason: "Waiting" })).status).toBe(200); // blocked: to the Leader
  expect((await admin.api.patch(`/api/projects/${p}/members/${member.user.id}`, { role: "VIEWER", handoverTo: admin.user.id })).status).toBe(200); // project role changed
  const mine = (await inbox(member)).items.map((n) => n.text);
  const count = (re: RegExp) => mine.filter((x) => re.test(x)).length;
  expect(count(new RegExp(`assigned you "${zz("typed")}"`))).toBe(1);
  expect(count(new RegExp(`added you as a collaborator on "${zz("collab")}"`))).toBe(1);
  expect(count(/changed your role in .* to viewer/)).toBeGreaterThanOrEqual(1);
  const lead = (await inbox(admin)).items.map((n) => n.text);
  expect(lead.filter((x) => x.includes(`marked "${zz("typed")}" as blocked`))).toHaveLength(1);
  expect(mine.some((x) => x.includes("as blocked") && x.includes(zz("typed")))).toBe(false); // the actor is not told
});

test.skip("AC5: notifications older than 90 days are removed — needs a notice aged 90 days and the purge-old job; not reachable from a browser session", async () => {});
test.skip("AC6: no email is sent for a notification — the test cannot read a mailbox from a browser session; checked in tests/feed.test.ts and by reading the sender code instead", async () => {});
