import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { dashboardTasks, dashboardProjects, dashboardActivity } from "@/lib/dashboard";
import { parseDueDate, startOfTodayIST, addDays } from "@/lib/dates";
import { account, cleanupZz, istDate, project, superAdmin, task, type Account } from "./helpers";
const projects: string[] = [], people: Account[] = [], tasks: string[] = [];
let member: Account, leader: Account, outsider: Account, owned: string, privateProject: string, privateTask: string;
const actor = () => ({ id: member.id, orgRole: "MEMBER" as const });
beforeAll(async () => {
  const sa = await superAdmin();
  member = await account("zzDashboard", `nakul17+zz-dashboard-${Date.now()}@aplyd.com`, "ZZ-TEST Dashboard member"); people.push(member);
  leader = await account("zzDashLeader", `nakul17+zz-dashboard-lead-${Date.now()}@aplyd.com`, "ZZ-TEST Dashboard leader"); people.push(leader);
  outsider = await account("zzDashOutsider", `nakul17+zz-dashboard-outsider-${Date.now()}@aplyd.com`, "ZZ-TEST Dashboard outsider"); people.push(outsider);
  const p = await project(sa, leader, [{ who: member }], `ZZ-TEST Dashboard owned ${Date.now()}`); owned = p.id; projects.push(owned);
  for (let i = 0; i < 8; i++) tasks.push(await task(sa, owned, { title: `ZZ-TEST Dashboard task ${i}`, assigneeId: member.id, dueDate: i === 3 ? istDate(-1) : i === 4 ? istDate(0) : istDate(2) }));
  await db.task.updateMany({ where: { id: { in: tasks.slice(0, 3) } }, data: { completedAt: new Date() } });
  await db.task.update({ where: { id: tasks[0] }, data: { assigneeId: leader.id } });
  await db.task.update({ where: { id: tasks[6] }, data: { dueDate: null } });
  await db.task.update({ where: { id: tasks[4] }, data: { approverId: member.id, assigneeId: member.id } });
  await db.taskCollaborator.create({ data: { taskId: tasks[3], userId: member.id } });
  await task(sa, owned, { title: "ZZ-TEST Dashboard subtask", assigneeId: member.id, parentId: tasks[5], dueDate: istDate(2) });
  const deleted = await task(sa, owned, { title: "ZZ-TEST Dashboard deleted", assigneeId: member.id });
  await db.task.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
  for (const kind of ["archived", "deleted", "private"]) {
    const other = await project(sa, leader, [{ who: member }], `ZZ-TEST Dashboard ${kind} ${Date.now()}`); projects.push(other.id);
    const tid = await task(sa, other.id, { title: `ZZ-TEST PRIVATE-${kind}`, assigneeId: member.id, dueDate: istDate(-2) });
    if (kind === "archived") await db.project.update({ where: { id: other.id }, data: { archivedAt: new Date() } });
    if (kind === "deleted") await db.project.update({ where: { id: other.id }, data: { deletedAt: new Date() } });
    if (kind === "private") { privateProject = other.id; privateTask = tid; await db.projectMember.delete({ where: { projectId_userId: { projectId: other.id, userId: member.id } } }); }
  }
  await db.actionLog.create({ data: { actorId: leader.id, projectId: owned, targetType: "task", targetId: tasks[4], action: "task.sent_for_approval", channel: "SCREEN", afterState: { assigneeId: member.id }, createdAt: new Date(Date.now() - 2 * 86400000) } });
}, 120000);
afterAll(async () => {
  await db.project.updateMany({ where: { id: { in: projects } }, data: { deletedAt: null, archivedAt: null } });
  await cleanupZz(projects, people);
});
it("deduplicates own work, excludes inaccessible/archived/deleted projects and counts beyond display limits", async () => {
  const data = await dashboardTasks(actor());
  expect(data.open).toBe(6); expect(data.overdue).toBe(1); expect(data.awaiting).toBe(1);
  expect(data.priorities).toHaveLength(4); expect(data.priorities[0].id).toBe(tasks[3]);
  expect(data.approvals[0].id).toBe(tasks[4]); expect(data.approvals[0].waitingDays).toBe(2);
  const response = await member.c.get("/api/dashboard?panel=tasks");
  expect(response.status).toBe(200); expect(response.json.open).toBe(6);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(JSON.stringify(response.json)).not.toContain(privateProject);
});
it("counts only non-deleted top-level project tasks and rounds 3/8 to 38 percent", async () => {
  const data = await dashboardProjects(actor());
  expect(data.total).toBe(1); expect(data.items).toHaveLength(1);
  expect(data.items[0]).toMatchObject({ id: owned, total: 8, completed: 3, percent: 38 });
});
it("uses IST midnight boundaries rather than browser or UTC calendar boundaries", async () => {
  const midnight = startOfTodayIST();
  const before = await dashboardTasks(actor(), new Date(midnight.getTime() - 1));
  const tomorrow = await dashboardTasks(actor(), new Date(addDays(midnight, 1).getTime() + 1));
  expect(before.overdue).toBe(0); expect(tomorrow.overdue).toBe(2);
  expect(parseDueDate(istDate(0)).getTime()).toBe(midnight.getTime());
});
it("denies Viewer approval and activity while retaining their own readable work", async () => {
  await db.projectMember.update({ where: { projectId_userId: { projectId: owned, userId: member.id } }, data: { role: "VIEWER" } });
  expect((await dashboardTasks(actor())).awaiting).toBe(0);
  expect((await dashboardActivity(actor())).items).toEqual([]);
  // Admin rights do not expand the dashboard beyond membership projects.
  expect((await dashboardProjects({ ...actor(), orgRole: "ADMIN" })).total).toBe(1);
  await db.projectMember.update({ where: { projectId_userId: { projectId: owned, userId: member.id } }, data: { role: "EDITOR" } });
});
it("activity isolates Editor task participation and private project events", async () => {
  const createdAt = new Date(Date.now() + 1000);
  for (const row of [{ projectId: privateProject, targetId: privateTask, marker: "PRIVATE-PROJECT-EVENT" }, { projectId: owned, targetId: tasks[0], marker: "PRIVATE-OTHER-TASK" }, { projectId: owned, targetId: tasks[3], marker: "VISIBLE-OWN-TASK" }]) {
    await db.actionLog.create({ data: { actorId: leader.id, projectId: row.projectId, targetType: "task", targetId: row.targetId, action: "task.updated", channel: "SCREEN", beforeState: { title: "Before" }, afterState: { title: row.marker }, createdAt } });
  }
  const data = await dashboardActivity(actor());
  const json = JSON.stringify(data);
  expect(json).toContain("VISIBLE-OWN-TASK"); expect(json).not.toContain("PRIVATE-PROJECT-EVENT"); expect(json).not.toContain("PRIVATE-OTHER-TASK");
  expect(data.items.length).toBeLessThanOrEqual(5);
});
it("approval queue has accurate totals and bounded authorized pagination", async () => {
  const original = await db.task.findUniqueOrThrow({ where: { id: tasks[4] } });
  await db.task.createMany({ data: Array.from({ length: 26 }, (_, i) => ({ workspaceId: original.workspaceId, projectId: owned, sectionId: original.sectionId, title: `ZZ-TEST approval page ${i}`, assigneeId: member.id, approverId: member.id, createdById: leader.id })) });
  const first = await member.c.get("/api/dashboard?panel=approvals");
  expect(first.status).toBe(200); expect(first.json.total).toBe(27); expect(first.json.items).toHaveLength(25);
  const second = await member.c.get(`/api/dashboard?panel=approvals&cursor=${first.json.nextCursor}`);
  expect(second.json.items).toHaveLength(2); expect(second.json.nextCursor).toBeNull();
  expect(new Set([...first.json.items, ...second.json.items].map((t: { id: string }) => t.id)).size).toBe(27);
  expect((await member.c.get(`/api/dashboard?panel=approvals&cursor=${privateTask}`)).status).toBe(404);
  const summary = await member.c.get("/api/dashboard?panel=tasks");
  expect(summary.json.open).toBe(32); expect(summary.json.awaiting).toBe(27); expect(summary.json.priorities).toHaveLength(4);
});

it("does not expose counts, activity or approval cursors to an outsider", async () => {
  for (const panel of ["tasks", "projects", "activity", "approvals"]) {
    const r = await outsider.c.get(`/api/dashboard?panel=${panel}&userId=${member.id}`);
    expect(r.status).toBe(200);
    if (panel === "tasks") expect(r.json).toMatchObject({ open: 0, overdue: 0, awaiting: 0, priorities: [], approvals: [] });
    else if (panel === "activity") expect(r.json.items).toEqual([]);
    else expect(r.json.total).toBe(0);
    expect(JSON.stringify(r.json)).not.toContain(owned);
  }
  expect((await outsider.c.get(`/api/dashboard?panel=approvals&cursor=${tasks[4]}`)).status).toBe(404);
  expect((await member.c.get("/api/dashboard?panel=unknown")).status).toBe(400);
});
it("respects CRM visibility while retaining the same membership scope", async () => {
  const sa = await superAdmin();
  const deal = await project(sa, leader, [{ who: member }], `ZZ-TEST Dashboard CRM ${Date.now()}`); projects.push(deal.id);
  await task(sa, deal.id, { title: "ZZ-TEST CRM own task", assigneeId: member.id });
  await db.project.update({ where: { id: deal.id }, data: { typeId: "wst_deal" } });
  const previous = process.env.CRM_VISIBLE;
  try {
    process.env.CRM_VISIBLE = "all"; const shown = await dashboardTasks(actor());
    process.env.CRM_VISIBLE = "off"; const hidden = await dashboardTasks(actor());
    expect(hidden.open).toBe(shown.open - 1);
    expect(JSON.stringify(await dashboardActivity(actor()))).not.toContain(deal.id);
  } finally {
    if (previous === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = previous;
    await db.project.update({ where: { id: deal.id }, data: { typeId: "wst_project" } });
  }
});
