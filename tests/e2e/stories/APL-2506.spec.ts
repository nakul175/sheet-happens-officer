// APL-2506 · SHO-US-7.1 Notification bell and panel
// Acceptance criteria: AC1 count and newest-first list, AC2 mark read, AC3 privacy, AC4 one notice per affected person per event,
// AC5 90-day retention, AC6 no email.
// Note: AC1 says the latest 30; SHO-US-14.13 changed the panel to 50 at a time with Load older. The test follows 14.13.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
// The file skips only when SHO_QA_PASS is unset. AC5 ages one row this test created and runs purge-old on localhost only.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, zz, BASE_URL, type Api } from "../support";
import { PASS, passwordOk } from "./qa";

// qa:TC uses the AC id already on the test. Pam has not published a separate hash for these cases.
const tag = (id: string) => ({ annotation: [{ type: "ac", description: id }, { type: "qa:TC", description: id }] });

test.beforeAll(() => {
  test.skip(!PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
});

async function version(who: { api: Api }, id: string) {
  const seen = await who.api.get(`/api/tasks/${id}`);
  expect(seen.status, JSON.stringify(seen.json)).toBe(200);
  return seen.json.task.updatedAt as string;
}

function mailFiles(email: string) {
  const dir = process.env.EMAIL_OUTBOX_DIR ?? path.join(process.cwd(), ".outbox");
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return new Set<string>(); }
  const want = email.toLowerCase();
  const hit = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const mail = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { to?: string };
      if (mail.to?.toLowerCase() === want) hit.add(file);
    } catch { /* a half-written file */ }
  }
  return hit;
}

/** Localhost only. Updates the one notification id this test created. Never a remote, staging, preview, or production database. */
function ageNotification(id: string, recipientId: string) {
  const raw = process.env.DATABASE_URL ?? "";
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("DATABASE_URL is missing or not a URL. AC5 will not age a notification."); }
  const host = parsed.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") throw new Error(`Refusing to age a notification: DATABASE_URL host is ${host}.`);
  const name = parsed.pathname.replace(/^\//, "");
  if (/prod|staging|preview/i.test(name)) throw new Error("Refusing to age a notification against a production, staging, or preview database.");
  const appHost = new URL(BASE_URL).hostname;
  if (appHost !== "localhost" && appHost !== "127.0.0.1" && appHost !== "::1") throw new Error("Refusing to run purge-old against a remote host.");
  if (!/^[a-z0-9]+$/i.test(id) || !/^[a-z0-9]+$/i.test(recipientId)) throw new Error("Refusing to age a notification: the id is not a single token.");
  parsed.searchParams.delete("schema");
  const aged = new Date(Date.now() - 91 * 86400_000).toISOString();
  const sql = `UPDATE "Notification" SET "createdAt" = timestamptz '${aged}' WHERE id = '${id}' AND "recipientId" = '${recipientId}'`;
  const out = execFileSync("psql", [parsed.toString(), "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
  expect(out).toContain("UPDATE 1");
}

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
/** Open the bell panel and wait until it is really showing (the page can still be settling after a load). */
async function openBell(page: any) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const dlg = page.getByRole("dialog", { name: "Notifications" });
  for (let i = 0; i < 3 && !(await dlg.isVisible()); i++) {
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await dlg.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  }
  await expect(dlg).toBeVisible();
  return dlg;
}
type N = { id: string; text: string; href: string; read: boolean; createdAt: string };
const inbox = async (who: any) => (await who.api.get("/api/notifications?limit=200")).json as { unread: number; items: N[] };

test("AC1: a new notification raises the count and appears first in the panel", tag("APL-2506 AC1"), async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "bell-new", later);
  const before = (await inbox(member)).unread;
  await mk(admin, p, zz("count me"), { assigneeId: member.user.id });
  const now = await inbox(member);
  expect(now.unread).toBe(before + 1);
  expect(now.items[0].text).toContain(zz("count me")); // newest first
  expect((await member.api.get("/api/notifications")).json.items.length).toBeLessThanOrEqual(50); // default page, SHO-US-14.13
  await member.page.goto("/");
  await expect(member.page.getByRole("button", { name: `Notifications, ${before + 1} unread` })).toBeVisible();
  const dlg = await openBell(member.page);
  await expect(dlg.getByRole("link", { name: zz("count me") })).toBeVisible();
});

test("AC2: opening an item marks it read and the count drops; Mark all as read clears the count", tag("APL-2506 AC2"), async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "bell-read", later);
  await mk(admin, p, zz("read one"), { assigneeId: member.user.id });
  await mk(admin, p, zz("read two"), { assigneeId: member.user.id });
  const start = (await inbox(member)).unread;
  expect(start).toBeGreaterThanOrEqual(2);
  const d1 = await openBell(member.page);
  await d1.getByRole("link", { name: zz("read two") }).click();
  await expect.poll(async () => (await inbox(member)).unread).toBe(start - 1);
  const d2 = await openBell(member.page); // the click opened the task; start again from a clean page
  // dispatch the click on the button itself: a closing-panel scrim can sit over it for a moment
  await d2.getByRole("button", { name: "Mark all as read" }).dispatchEvent("click");
  await expect.poll(async () => (await inbox(member)).unread).toBe(0);
  await expect(member.page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible(); // no count left
});

test("AC3: another person's notifications are never returned or changed", tag("APL-2506 AC3"), async ({ admin, member, later }) => {
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

test("AC4: each event in the list gives exactly one notification to the affected person and none to the person who caused it", tag("APL-2506 AC4"), async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "bell-types", later);
  const t = await mk(admin, p, zz("typed"), { assigneeId: member.user.id });                       // assigned
  await mk(admin, p, zz("collab"), { collaboratorIds: [member.user.id] });               // added as collaborator
  expect((await member.api.patch(`/api/tasks/${t}`, { blocked: true, blockedReason: "Waiting", expectedUpdatedAt: await version(member, t) })).status).toBe(200); // blocked: to the Leader
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

test("AC5: notifications older than 90 days are removed", tag("APL-2506 AC5"), async ({ admin, member, later }) => {
  const secret = process.env.JOB_SECRET ?? "";
  if (secret.length < 16) throw new Error("Set JOB_SECRET (16 characters or more) to run purge-old on the local server.");
  const p = await withMember(admin, member, "bell-old", later);
  await mk(admin, p, zz("aged notice"), { assigneeId: member.user.id });
  const aged = (await inbox(member)).items.find((n) => n.text.includes(zz("aged notice")));
  expect(aged, "the notice to age").toBeTruthy();
  ageNotification(aged!.id, member.user.id as string);
  await mk(admin, p, zz("fresh notice"), { assigneeId: member.user.id });
  const fresh = (await inbox(member)).items.find((n) => n.text.includes(zz("fresh notice")));
  expect(fresh, "a new notice stays").toBeTruthy();
  const res = await fetch(new URL("/api/jobs/purge-old", BASE_URL), { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  const body = await res.text();
  expect(body.includes(secret)).toBe(false);
  expect(res.status, body).toBe(200);
  const left = (await inbox(member)).items;
  expect(left.some((n) => n.id === aged!.id)).toBe(false);
  expect(left.some((n) => n.id === fresh!.id)).toBe(true);
});

test("AC6: no email is sent for a notification", tag("APL-2506 AC6"), async ({ admin, member, later }) => {
  const before = mailFiles(member.user.email as string);
  const p = await withMember(admin, member, "bell-mail", later);
  await mk(admin, p, zz("no mail"), { assigneeId: member.user.id });
  const note = (await inbox(member)).items.find((n) => n.text.includes(zz("no mail")));
  expect(note, "the notice was created in the bell").toBeTruthy();
  expect([...mailFiles(member.user.email as string)].filter((file) => !before.has(file))).toEqual([]);
});
