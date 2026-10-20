// SHO-E7 Notifications (Linear APL-2471).
// One test per acceptance criterion. People are nakul17+ aliases signed in with SHO_QA_PASS.
// Records are ZZ-TEST and archived afterwards. People are the job's reused pool aliases (APL-2748), so notices
// from earlier runs are in their bells: a check either names this run's records or looks only at new notices.
// Pam left no qa:TC cases on this issue.
import type { Page } from "@playwright/test";
import { test, expect, zz } from "../support";
import { newProject, newTask, ymd, type Who } from "../g2";
import { QA_PASS, cast, gateFile, noSecret, runLocalJob } from "../helpers/qa-alias";

gateFile();

type Note = { id: string; text: string; href: string; read: boolean };
type Later = (fn: () => Promise<unknown>) => void;

const inbox = async (who: Who) => {
  const r = await who.api.get("/api/notifications?limit=200");
  noSecret(JSON.stringify(r.json));
  return r.json as { unread: number; items: Note[] };
};
const about = (items: Note[], title: string) => items.filter((n) => n.text.includes(`"${title}"`));
/** Notices that arrived after `before` was read. A reused account already holds older ones with the same text. */
const since = (items: Note[], before: Note[]) => { const old = new Set(before.map((n) => n.id)); return items.filter((n) => !old.has(n.id)); };

/** POST /assign with the task's current version, which main requires on every task mutation (APL-2668). */
async function assign(who: Who, taskId: string, assigneeId: string) {
  const seen = await who.api.get(`/api/tasks/${taskId}`);
  expect(seen.status, JSON.stringify(seen.json)).toBe(200);
  return who.api.post(`/api/tasks/${taskId}/assign`, { assigneeId, expectedUpdatedAt: seen.json.task.updatedAt });
}

async function openBell(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const dlg = page.getByRole("dialog", { name: "Notifications" });
  for (let i = 0; i < 3 && !(await dlg.isVisible()); i++) {
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await dlg.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  }
  await expect(dlg).toBeVisible();
  return dlg;
}

test("AC1: the bell shows the unread count and the panel lists the notices; opening one marks it read", async ({ browser, later }) => {
  const { admin, people: [member] } = await cast(browser, later, ["bell"]);
  const p = await newProject(admin, later, { label: "e7 bell", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("bell task");
  await newTask(admin, p.id, { title, assigneeId: member.user.id });
  const now = await inbox(member);
  const hit = about(now.items, title);
  expect(hit).toHaveLength(1);
  expect(hit[0].read).toBe(false);
  expect(now.unread).toBeGreaterThanOrEqual(1);
  await member.page.goto("/");
  await expect(member.page.getByRole("button", { name: `Notifications, ${now.unread} unread` })).toBeVisible();
  const dlg = await openBell(member.page);
  // Each notice is a link whose name holds the task title (unique to this run).
  const notice = dlg.getByRole("link", { name: title });
  await expect(notice).toBeVisible();
  await notice.click();
  await expect.poll(async () => (await inbox(member)).items.find((n) => n.id === hit[0].id)?.read).toBe(true);
  expect((await inbox(member)).unread).toBe(now.unread - 1);
});

test("AC2: the new assignee is told about an assignment and a reassignment, and not when they assigned it themselves", async ({ browser, later }) => {
  const { admin, people: [member, other] } = await cast(browser, later, ["assignee", "next"]);
  const p = await newProject(admin, later, { label: "e7 assign", members: [{ who: member, role: "EDITOR" }, { who: other, role: "EDITOR" }] });
  const title = zz("handed");
  const t = await newTask(admin, p.id, { title, assigneeId: admin.user.id });
  expect((await assign(admin, t, String(member.user.id))).status).toBe(200);
  expect(about(await (await inbox(member)).items, title).map((n) => n.text)).toEqual([`${admin.user.name} assigned you "${title}".`]);
  expect((await assign(admin, t, String(other.user.id))).status).toBe(200);
  expect(about((await inbox(other)).items, title).some((n) => n.text.includes(`${admin.user.name} assigned you`))).toBe(true);
  expect(about((await inbox(member)).items, title).some((n) => n.text.includes("took"))).toBe(true);
  const own = zz("own assign");
  await newTask(member, p.id, { title: own, assigneeId: member.user.id });
  expect(about((await inbox(member)).items, own)).toHaveLength(0);
});

test("AC3: when an Editor deletes a task, the Leader and everyone on the task are told, and the deleter is not", async ({ browser, later }) => {
  const { admin, people: [editor, holder, mate] } = await cast(browser, later, ["deleter", "holder", "mate"]);
  const p = await newProject(admin, later, { label: "e7 delete", members: [{ who: editor, role: "EDITOR" }, { who: holder, role: "EDITOR" }, { who: mate, role: "EDITOR" }] });
  const title = zz("trashed");
  const t = await newTask(editor, p.id, { title, assigneeId: holder.user.id });
  expect((await editor.api.post(`/api/tasks/${t}/collaborators`, { userId: mate.user.id })).status).toBe(201);
  const removed = await editor.api.del(`/api/tasks/${t}`);
  expect(removed.status).toBe(204);
  noSecret(JSON.stringify(removed.json));
  for (const who of [admin, holder, mate]) {
    const hits = about((await inbox(who)).items, title).filter((n) => n.text.includes("to Trash"));
    expect(hits, who.user.email as string).toHaveLength(1);
    expect(hits[0].href).toBe(`/projects/${p.id}/trash`);
  }
  expect(about((await inbox(editor)).items, title).some((n) => n.text.includes("to Trash"))).toBe(false);
});

test("AC4: a task due tomorrow or overdue produces at most one reminder for its assignee when the daily job runs @local-only", async ({ browser, later }) => {
  const { admin, people: [holder] } = await cast(browser, later, ["due"]);
  const p = await newProject(admin, later, { label: "e7 due", members: [{ who: holder, role: "EDITOR" }] });
  const tomorrow = zz("due tomorrow");
  const late = zz("overdue one");
  await newTask(admin, p.id, { title: tomorrow, assigneeId: holder.user.id, dueDate: ymd(1) });
  await newTask(admin, p.id, { title: late, assigneeId: holder.user.id, dueDate: ymd(-1) });
  const jobs = (await admin.api.get("/api/jobs")).json.jobs as { job: string; about: string }[];
  expect(jobs.find((j) => j.job === "reminders")?.about).toMatch(/8:00/);
  await runLocalJob("reminders");
  await runLocalJob("reminders");
  const texts = (await inbox(holder)).items.map((n) => n.text);
  expect(texts.filter((t) => t === `"${tomorrow}" is due tomorrow.`)).toHaveLength(1);
  expect(texts.filter((t) => t === `"${late}" is overdue by 1 day.`)).toHaveLength(1);
  expect(JSON.stringify(texts).includes(QA_PASS)).toBe(false);
});

test("AC5: a membership or role change tells the person it affects", async ({ browser, later }) => {
  const { admin, people: [member] } = await cast(browser, later, ["role"]);
  const p = await newProject(admin, later, { label: "e7 role", members: [{ who: member, role: "EDITOR" }] });
  const start = (await inbox(member)).items;
  expect((await admin.api.patch(`/api/projects/${p.id}/members/${member.user.id}`, { role: "VIEWER" })).status).toBe(200);
  expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "ADMIN" })).status).toBe(200);
  later(() => admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" }));
  const texts = since((await inbox(member)).items, start).map((n) => n.text);
  expect(texts.some((t) => t.includes(`${admin.user.name} changed your role in "${p.name}" to viewer`))).toBe(true);
  expect(texts.some((t) => t.includes(`${admin.user.name} changed your role to admin`))).toBe(true);
  const promoted = (await inbox(member)).items;
  expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" })).status).toBe(200);
  expect(since((await inbox(member)).items, promoted).some((n) => n.text.includes(`${admin.user.name} changed your role to member`))).toBe(true);
});

test("AC6: when a deactivated person's tasks are reassigned, the receivers are told", async ({ browser, later }) => {
  const { admin, people: [leader, leaver] } = await cast(browser, later, ["receiver", "leaver"]);
  const p = await newProject(admin, later, { label: "e7 leave", leader, members: [{ who: leaver, role: "EDITOR" }] });
  later(() => admin.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: admin.user.id, previousRole: "EDITOR" }));
  const title = zz("left behind");
  const taskId = await newTask(admin, p.id, { title, assigneeId: leaver.user.id });
  const gone = await admin.api.post(`/api/team/${leaver.user.id}/deactivate`, { reassign: "leaders" });
  expect(gone.status, JSON.stringify(gone.json)).toBe(200);
  noSecret(JSON.stringify(gone.json));
  const told = `${admin.user.name} handed over ${leaver.user.name}'s work in a project: 1 open task is now yours.`;
  // The sentence names no run-unique record, so match this run's project too.
  const hits = (await inbox(leader)).items.filter((n) => n.text === told && n.href === `/projects/${p.id}`);
  expect(hits).toHaveLength(1);
  expect(hits[0].href).toBe(`/projects/${p.id}`);
  expect((await admin.api.get(`/api/tasks/${taskId}`)).json.task.assignee.id).toBe(leader.user.id);
  expect((await inbox(admin)).items.some((n) => n.text === told && n.href === `/projects/${p.id}`)).toBe(false);
});

test("AC7: one transaction that would notify one person twice about the same project and task sends one notice", async ({ browser, later }) => {
  const { admin, people: [editor] } = await cast(browser, later, ["once"]);
  const p = await newProject(admin, later, { label: "e7 once", members: [{ who: editor, role: "EDITOR" }] });
  const title = zz("one notice");
  const t = await newTask(editor, p.id, { title, assigneeId: admin.user.id });
  expect((await editor.api.del(`/api/tasks/${t}`)).status).toBe(204);
  const hits = about((await inbox(admin)).items, title).filter((n) => n.text.includes("to Trash"));
  expect(hits, "Leader and assignee are the same person").toHaveLength(1);
});
