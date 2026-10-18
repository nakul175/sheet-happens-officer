// Undo, the richer action log and the audit log (SHO-US-6.3, 6.4, 6.5, 7.1 to 7.3).
// Server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com and DATABASE_URL pointing at the same database.
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { account, project, superAdmin, task, type Account } from "./helpers";

const db = new PrismaClient();

const activity = async (lead: Account, projectId: string) =>
  (await lead.c.get(`/api/projects/${projectId}/activity`)).json.items as { id: string; what: string; undo: string; via: string }[];
// The delete's own log row: an Editor's delete sends no x-undo-* headers once Undo is hidden from them (APL-2649).
const deleteRow = (taskId: string, actorId: string) =>
  db.actionLog.findFirstOrThrow({ where: { action: "task.deleted", targetId: taskId, actorId }, orderBy: { createdAt: "desc" } });
const notices = async (who: Account) => (await who.c.get("/api/notifications")).json.items as { text: string; href: string }[];

describe("undo (6.4)", () => {
  it("reverts an unchanged edit, logs it, and marks the original undone (AC1)", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(ed, p.id, { title: "Before", priority: "LOW" });
    const r = await ed.c.patch(`/api/tasks/${t}`, { title: "After" });
    expect(r.headers.get("x-undo-id")).toBeTruthy();
    expect(r.headers.get("x-undo-label")).toBe("Task edited");
    const u = await ed.c.post(`/api/actions/${r.headers.get("x-undo-id")}/undo`);
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.label).toBe("Task edited");
    expect((await ed.c.get(`/api/tasks/${t}`)).json.task.title).toBe("Before");
    const rows = await activity(lead, p.id);
    expect(rows[0].what).toMatch(/undid "task edited"/);
    expect(rows.find((x) => x.id === r.headers.get("x-undo-id"))!.undo).toBe("undone");
    expect((await ed.c.post(`/api/actions/${r.headers.get("x-undo-id")}/undo`)).status).toBe(409); // not twice
  });

  it("warns when someone changed the same field, and Undo anyway reverts only my fields (AC2, AC3)", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(ed, p.id, { title: "Keep", priority: "LOW" });
    const mine = await ed.c.patch(`/api/tasks/${t}`, { priority: "HIGH" });
    await lead.c.patch(`/api/tasks/${t}`, { priority: "URGENT", description: "their note" });
    const id = mine.headers.get("x-undo-id");
    const w = await ed.c.post(`/api/actions/${id}/undo`);
    expect(w.status).toBe(409);
    expect(w.json.needsConfirm).toBe("conflict");
    expect(w.json.conflicts).toEqual([{ field: "Priority", before: "LOW", after: "HIGH", now: "URGENT" }]);
    expect(w.json.changedBy).toEqual(["Lead"]);
    expect((await ed.c.get(`/api/tasks/${t}`)).json.task.priority).toBe("URGENT"); // not silently reverted
    const a = await ed.c.post(`/api/actions/${id}/undo`, { anyway: true });
    expect(a.status).toBe(200);
    const now = (await ed.c.get(`/api/tasks/${t}`)).json.task;
    expect(now.priority).toBe("LOW");
    expect(now.description).toBe("their note"); // their other edit stays
    expect((await notices(lead)).some((n) => /Editor undid their own change and replaced your change to "Keep"/.test(n.text))).toBe(true);
    const audit = (await sa.c.get("/api/audit?event=UNDO_OVERRIDE")).json.items as { event: string; target: string }[];
    expect(audit.some((x) => /Task "Keep"/.test(x.target))).toBe(true);
  });

  it("lets Editors undo only their own actions; Leaders and Admins any (AC5)", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const other = await account("other");
    const viewer = await account("viewer");
    const p = await project(lead, lead, [{ who: ed }, { who: other }, { who: viewer, role: "VIEWER" }]);
    const t = await task(ed, p.id, { title: "Mine" });
    const r = await ed.c.patch(`/api/tasks/${t}`, { title: "Edited" });
    const id = r.headers.get("x-undo-id");
    expect((await other.c.post(`/api/actions/${id}/undo`)).status).toBe(403);
    expect((await viewer.c.post(`/api/actions/${id}/undo`)).status).toBe(403);
    expect((await lead.c.post(`/api/actions/${id}/undo`)).status).toBe(200);
    expect((await ed.c.get(`/api/tasks/${t}`)).json.task.title).toBe("Mine");
  });

  it("refuses actions older than 30 days with 'Too old to undo' (AC6, 6.3 AC6)", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const t = await task(lead, p.id, { title: "Old" });
    const r = await lead.c.patch(`/api/tasks/${t}`, { title: "Older" });
    const id = r.headers.get("x-undo-id")!;
    await db.actionLog.update({ where: { id }, data: { createdAt: new Date(Date.now() - 31 * 86400_000) } });
    const u = await lead.c.post(`/api/actions/${id}/undo`);
    expect(u.status).toBe(409);
    expect(u.json.error).toBe("Too old to undo");
    expect((await activity(lead, p.id)).find((x) => x.id === id)!.undo).toBe("too_old");
  });

  it("refuses an Editor's Undo of their own delete with the Trash restore rule, and restores nothing (SHO-BUG-8 AC1, AC3)", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(lead, p.id, { title: "Oops", assigneeId: ed.id });
    expect((await ed.c.del(`/api/tasks/${t}`)).status).toBeLessThan(300);
    const { id } = await deleteRow(t, ed.id);
    const restore = await ed.c.post(`/api/tasks/${t}/restore`); // the unauthorised restore from Trash
    expect(restore.status).toBe(403);
    const u = await ed.c.post(`/api/actions/${id}/undo`);
    expect(u.status).toBe(403);
    expect(u.json.error).toBe(restore.json.error);
    expect(u.json.error).toBe("Only the project Leader or an Admin can do this.");
    const bulk = await ed.c.post("/api/actions/bulk-undo", { ids: [id] }); // the server refuses on every Undo route, not just the button
    expect(bulk.status).toBe(403);
    expect(bulk.json.error).toBe(restore.json.error);
    expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(404);
    expect((await db.task.findUniqueOrThrow({ where: { id: t } })).deletedAt).not.toBeNull();
    const row = await db.actionLog.findUniqueOrThrow({ where: { id } });
    expect(row.undoneAt).toBeNull();
    expect(await db.actionLog.count({ where: { action: "undo", targetId: t } })).toBe(0);
  });

  it("lets a Leader or an Admin undo a delete like a restore, logs it, and says notices were sent (SHO-BUG-8 AC2)", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    for (const who of [lead, sa]) {
      const t = await task(lead, p.id, { title: "Oops", assigneeId: ed.id });
      expect((await ed.c.del(`/api/tasks/${t}`)).status).toBeLessThan(300);
      expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(404);
      const { id } = await deleteRow(t, ed.id);
      const u = await who.c.post(`/api/actions/${id}/undo`);
      expect(u.status, JSON.stringify(u.json)).toBe(200);
      expect(u.json.noticesSent).toBe(true);
      expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(200);
      expect((await db.actionLog.findUniqueOrThrow({ where: { id } })).undoneById).toBe(who.id);
      const log = await db.actionLog.findFirst({ where: { action: "undo", targetId: t, actorId: who.id } });
      expect(log?.beforeState).toMatchObject({ undoes: id, action: "task.deleted" });
      expect((await activity(lead, p.id))[0].what).toMatch(/undid "task deleted"/);
    }
  });

  it("undoes complete (with subtasks), move, assign and collaborators", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(lead, p.id, { title: "Flow", assigneeId: lead.id });
    const sub = await task(lead, p.id, { parentId: t });
    const done = await lead.c.post(`/api/tasks/${t}/complete`, { completeAll: true });
    expect(done.status).toBe(200);
    expect((await lead.c.post(`/api/actions/${done.headers.get("x-undo-id")}/undo`)).status).toBe(200);
    const open = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect(open.completedAt).toBeNull();
    expect((await lead.c.get(`/api/tasks/${sub}`)).json.task.completedAt).toBeNull();

    const mv = await lead.c.post(`/api/tasks/${t}/move`, { sectionId: p.doing });
    expect((await lead.c.post(`/api/actions/${mv.headers.get("x-undo-id")}/undo`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.sectionId).toBe(p.todo);

    const as = await lead.c.post(`/api/tasks/${t}/assign`, { assigneeId: ed.id });
    expect((await lead.c.post(`/api/actions/${as.headers.get("x-undo-id")}/undo`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(lead.id);

    const col = await lead.c.post(`/api/tasks/${t}/collaborators`, { userId: ed.id });
    expect((await lead.c.post(`/api/actions/${col.headers.get("x-undo-id")}/undo`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.collaborators).toHaveLength(0);
  });

  it("undoes section, member and archive changes; refuses what cannot be undone", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead);
    const add = await lead.c.post(`/api/projects/${p.id}/sections`, { name: "Review" });
    expect((await lead.c.post(`/api/actions/${add.headers.get("x-undo-id")}/undo`)).status).toBe(200);
    expect(((await lead.c.get(`/api/projects/${p.id}`)).json.project.sections as unknown[]).length).toBe(3);

    const mem = await lead.c.post(`/api/projects/${p.id}/members`, { userId: ed.id, role: "EDITOR" });
    expect((await lead.c.post(`/api/actions/${mem.headers.get("x-undo-id")}/undo`)).status).toBe(200);
    expect(((await lead.c.get(`/api/projects/${p.id}`)).json.project.members as unknown[]).length).toBe(1);

    const arc = await lead.c.post(`/api/projects/${p.id}/archive`);
    expect(arc.headers.get("x-undo-label")).toBe("Project archived");
    expect((await lead.c.post(`/api/actions/${arc.headers.get("x-undo-id")}/undo`)).status).toBe(200);
    expect((await lead.c.get(`/api/projects/${p.id}`)).json.project.archived).toBe(false);

    // A removal that handed tasks over is not undoable (decided in 8.3).
    await lead.c.post(`/api/projects/${p.id}/members`, { userId: ed.id, role: "EDITOR" });
    await task(lead, p.id, { assigneeId: ed.id });
    const rm = await lead.c.del(`/api/projects/${p.id}/members/${ed.id}?handoverTo=${lead.id}`);
    expect(rm.status, JSON.stringify(rm.json)).toBeLessThan(300);
    const u = await lead.c.post(`/api/actions/${rm.headers.get("x-undo-id")}/undo`);
    expect(u.status).toBe(409);
    expect(u.json.error).toMatch(/handed over/);
  });
});

describe("notices (7.1 to 7.3)", () => {
  it("names the reason in a Blocked notice (4.4 AC4)", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(ed, p.id, { title: "Stuck" });
    await ed.c.patch(`/api/tasks/${t}`, { blocked: true, blockedReason: "Waiting for the client" });
    expect((await notices(lead)).some((n) => /marked "Stuck" as blocked: Waiting for the client/.test(n.text))).toBe(true);
  });

  it("tells the previous assignee, and links a deleted-task notice to Trash", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(lead, p.id, { title: "Handed", assigneeId: ed.id });
    await lead.c.post(`/api/tasks/${t}/assign`, { assigneeId: lead.id });
    expect((await notices(ed)).some((n) => /took "Handed" off you/.test(n.text))).toBe(true);
    await lead.c.post(`/api/tasks/${t}/assign`, { assigneeId: ed.id });
    await lead.c.del(`/api/tasks/${t}`);
    const del = (await notices(ed)).find((n) => /moved "Handed" to Trash/.test(n.text))!;
    expect(del.href).toBe(`/projects/${p.id}/trash`);
  });

  it("sends one counted notice to the Leader on deactivation, naming approvers and cleared approvers (7.2 AC5, 4.6 AC8)", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const worker = await account("worker");
    await lead.c.post(`/api/projects/${p.id}/members`, { userId: worker.id, role: "EDITOR" });
    await task(lead, p.id, { assigneeId: ed.id });
    await task(lead, p.id, { assigneeId: ed.id });
    await task(lead, p.id, { assigneeId: worker.id, approverId: ed.id });
    await task(lead, p.id, { assigneeId: lead.id, approverId: ed.id });
    const before = (await notices(lead)).length;
    expect((await sa.c.post(`/api/team/${ed.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    const fresh = (await notices(lead)).slice(0, (await notices(lead)).length - before >= 0 ? (await notices(lead)).length - before : 0);
    const handover = fresh.filter((n) => /handed over Editor's work/.test(n.text));
    expect(handover).toHaveLength(1);
    expect(handover[0].text).toMatch(/2 open tasks are now yours/);
    expect(handover[0].text).toMatch(/you now approve 2 tasks/);
    expect(handover[0].text).toMatch(/1 task no longer has an approver/);
  });

  it("names tasks when few and counts when 5 or more for a removed person (7.2 AC3)", async () => {
    const lead = await account("lead");
    const few = await account("few");
    const many = await account("many");
    const p = await project(lead, lead, [{ who: few }, { who: many }]);
    await task(lead, p.id, { title: "One", assigneeId: few.id });
    for (let i = 0; i < 5; i++) await task(lead, p.id, { assigneeId: many.id });
    await lead.c.del(`/api/projects/${p.id}/members/${few.id}?handoverTo=${lead.id}`);
    await lead.c.del(`/api/projects/${p.id}/members/${many.id}?handoverTo=${lead.id}`);
    expect((await notices(few))[0].text).toMatch(/Your open task "One" was handed to someone else/);
    expect((await notices(many))[0].text).toMatch(/5 open tasks of yours were handed to someone else/);
  });
});

describe("action log and audit log (6.3, 6.5)", () => {
  it("records bulk writes, per-subtask completion and states, and 'via concierge' rows stay readable", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(lead, p.id, { title: "Parent", assigneeId: ed.id });
    const sub = await task(lead, p.id, { parentId: t, assigneeId: ed.id });
    await task(lead, p.id, { assigneeId: ed.id });
    await lead.c.post(`/api/tasks/${t}/complete`, { completeAll: true });
    await lead.c.del(`/api/projects/${p.id}/members/${ed.id}?handoverTo=${lead.id}`);
    const rows = await db.actionLog.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } });
    const acts = rows.map((r) => r.action);
    expect(acts.filter((a) => a === "task.completed").length).toBe(2); // parent and subtask
    expect(rows.find((r) => r.action === "task.completed" && r.targetId === sub)).toBeTruthy();
    expect(acts).toContain("tasks.reassigned");
    const rem = rows.find((r) => r.action === "member.removed")!;
    expect(rem.beforeState).toMatchObject({ role: "EDITOR" });
    expect(rem.afterState).toMatchObject({ removed: true });
    const del = await db.actionLog.findFirst({ where: { projectId: p.id, action: "task.completed", targetId: t } });
    expect(del?.beforeState).toMatchObject({ completedAt: null });
    expect((await lead.c.get(`/api/projects/${p.id}/activity`)).status).toBe(200);
    const au = (await sa.c.get("/api/audit")).json;
    expect(au.items[0]).toHaveProperty("channel");
  });

  it("writes SIGN_OUT_EVERYWHERE, distinct promote/demote events and a lockout row on the 5th failure", async () => {
    const sa = await superAdmin();
    const m = await account("member");
    await sa.c.patch(`/api/team/${m.id}`, { orgRole: "ADMIN" });
    await sa.c.patch(`/api/team/${m.id}`, { orgRole: "MEMBER" });
    await m.c.post("/api/profile/sessions/sign-out-others");
    const events = (await sa.c.get("/api/audit")).json.events as string[];
    expect(events).toEqual(expect.arrayContaining(["ADMIN_PROMOTED", "ADMIN_DEMOTED", "SIGN_OUT_EVERYWHERE"]));
    const victim = await account("victim");
    for (let i = 0; i < 5; i++) await new (victim.c.constructor as new () => typeof victim.c)().post("/api/auth/signin", { email: victim.email, password: "wrong-password-1" });
    const locked = await db.auditLog.count({ where: { event: "SIGN_IN_LOCKED", actorId: victim.id } });
    expect(locked).toBeGreaterThanOrEqual(1);
  });

  it("audits an approver named at creation", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(lead, p.id, { title: "Audited", approverId: ed.id });
    const row = await db.auditLog.findFirst({ where: { event: "APPROVER_CHANGED", targetId: t } });
    expect(row?.targetType).toBe("task");
    expect(row?.actorId).toBe(lead.id);
    expect(sa).toBeTruthy();
  });
});
