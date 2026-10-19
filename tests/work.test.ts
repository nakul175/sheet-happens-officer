// Integration tests for roles, projects, members, Sections and tasks (SHO-US-2.x to 6.2).
// Server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com and the same EMAIL_OUTBOX_DIR; DATABASE_URL points at the same database.
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { Client, account, admin, bulkWithVersions, istDate, project, superAdmin, task, type Account, patchTask, withVersion } from "./helpers";
import { assignTask, completeTask, moveTask, setApprover } from "../src/lib/tasks";
import { execute } from "../src/lib/concierge/changes";

const db = new PrismaClient();

describe("people and roles (2.x)", () => {
  it("makes the configured address Super Admin", async () => {
    const sa = await superAdmin();
    expect((await sa.c.get("/api/auth/me")).json.user.orgRole).toBe("SUPER_ADMIN");
  });

  it("only the Super Admin changes org roles, and never to or from Super Admin", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const m = await account("member");
    expect((await ad.c.patch(`/api/team/${m.id}`, { orgRole: "ADMIN" })).status).toBe(403);
    expect((await m.c.patch(`/api/team/${m.id}`, { orgRole: "ADMIN" })).status).toBe(403);
    expect((await sa.c.patch(`/api/team/${m.id}`, { orgRole: "SUPER_ADMIN" })).status).toBe(400);
    expect((await sa.c.patch(`/api/team/${sa.id}`, { orgRole: "MEMBER" })).status).toBe(403);
    expect((await sa.c.patch(`/api/team/${ad.id}`, { orgRole: "MEMBER" })).status).toBe(200);
  });

  it("shows Members names only, and Admins everything including unverified people", async () => {
    const sa = await superAdmin();
    const m = await account("viewer1");
    const ghost = new Client();
    const email = `ghost${Date.now()}@aplyd.com`;
    await ghost.post("/api/auth/signup", { name: "Ghost", email, password: "correct-horse-9" });
    const asMember = (await m.c.get("/api/team")).json.people as Record<string, unknown>[];
    expect(asMember.every((p) => Object.keys(p).sort().join() === "id,leads,name,orgRole" /* SHO-US-14.4 AC3 adds role and led projects */)).toBe(true);
    expect(asMember.some((p) => p.name === "Ghost")).toBe(false);
    const asSuper = (await sa.c.get("/api/team")).json.people as Record<string, string>[];
    expect(asSuper.find((p) => p.email === email)?.status).toBe("UNVERIFIED");
  });

  it("deactivates, ends sessions, blocks a Leader, and Admins cannot touch Admins", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const ad2 = await admin(sa, "admin2");
    const lead = await account("lead");
    const leaver = await account("leaver");
    const p = await project(lead, lead, [{ who: leaver }]);
    expect((await ad.c.post(`/api/team/${ad2.id}/deactivate`, { reassign: "leaders" })).status).toBe(403);
    expect((await ad.c.post(`/api/team/${sa.id}/deactivate`, { reassign: "leaders" })).status).toBe(403);
    expect((await ad.c.post(`/api/team/${lead.id}/deactivate`, { reassign: "leaders" })).status).toBe(409); // leads a project
    const t = await task(leaver, p.id);
    const r = await ad.c.post(`/api/team/${leaver.id}/deactivate`, { reassign: "leaders" });
    expect(r.status).toBe(200);
    expect(r.json.moved).toBe(1);
    expect((await leaver.c.get("/api/auth/me")).status).toBe(401);
    expect((await new Client().post("/api/auth/signin", { email: leaver.email, password: "correct-horse-9" })).status).toBe(403);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(lead.id);
    expect((await ad.c.post(`/api/team/${leaver.id}/reactivate`)).status).toBe(200);
    expect((await leaver.c.post("/api/auth/signin", { email: leaver.email, password: "correct-horse-9" })).status).toBe(200);
    // Membership is back, the task is not.
    expect((await leaver.c.get(`/api/projects/${p.id}`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(lead.id);
  });

  it("deactivation hands tasks to a named person, falling back to the Leader outside their project", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const leaver = await account("leaver");
    const friend = await account("friend");
    const inP = await project(lead, lead, [{ who: leaver }, { who: friend }]);
    const outP = await project(lead, lead, [{ who: leaver }]); // friend is not a member here
    const a = await task(leaver, inP.id);
    const b = await task(leaver, outP.id);
    const r = await sa.c.post(`/api/team/${leaver.id}/deactivate`, { reassign: friend.id });
    expect(r.status).toBe(200);
    expect(r.json.fellBack).toHaveLength(1);
    expect((await lead.c.get(`/api/tasks/${a}`)).json.task.assignee.id).toBe(friend.id);
    expect((await lead.c.get(`/api/tasks/${b}`)).json.task.assignee.id).toBe(lead.id);
  });
});

describe("projects and access (3.x)", () => {
  it("creates with three Sections, requires an active Leader, and adds the creator as Editor", async () => {
    const creator = await account("creator");
    const lead = await account("lead");
    const bad = await creator.c.post("/api/projects", { name: "X" });
    expect(bad.status).toBe(400);
    expect((await creator.c.post("/api/projects", { name: "X", leaderId: "nobody" })).status).toBe(400);
    const p = await project(creator, lead);
    const detail = (await lead.c.get(`/api/projects/${p.id}`)).json.project;
    expect(detail.sections.map((s: { name: string }) => s.name)).toEqual(["To do", "In progress", "Done"]);
    expect(detail.sections.filter((s: { isDone: boolean }) => s.isDone)).toHaveLength(1);
    expect(detail.members.find((m: { userId: string }) => m.userId === creator.id).role).toBe("EDITOR");
    expect(detail.members.find((m: { userId: string }) => m.userId === lead.id).role).toBe("LEADER");
  });

  it("shows non-members nothing: not found, empty lists, Admins see all", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const outsider = await account("outsider");
    const p = await project(lead, lead);
    const t = await task(lead, p.id);
    expect((await outsider.c.get(`/api/projects/${p.id}`)).status).toBe(404);
    expect((await outsider.c.get(`/api/projects/${p.id}/tasks`)).status).toBe(404);
    expect((await outsider.c.get(`/api/tasks/${t}`)).status).toBe(404);
    expect((await outsider.c.post(`/api/projects/${p.id}/tasks`, { title: "x" })).status).toBe(404);
    expect((await outsider.c.get("/api/projects")).json.projects).toHaveLength(0);
    expect((await sa.c.get(`/api/projects/${p.id}`)).status).toBe(200);
  });

  it("limits member management to Leader and Admins, and requires a hand-over for open tasks", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const ed2 = await account("editor2");
    const extra = await account("extra");
    const p = await project(lead, lead, [{ who: ed }, { who: ed2 }]);
    expect((await ed.c.post(`/api/projects/${p.id}/members`, { userId: extra.id })).status).toBe(403);
    expect((await lead.c.post(`/api/projects/${p.id}/members`, { userId: extra.id })).status).toBe(201);
    expect((await lead.c.post(`/api/projects/${p.id}/members`, { userId: extra.id })).status).toBe(409);
    const t = await task(ed, p.id);
    expect((await lead.c.del(`/api/projects/${p.id}/members/${ed.id}`)).status).toBe(409); // no taker chosen
    const viewer = await account("viewer");
    await lead.c.post(`/api/projects/${p.id}/members`, { userId: viewer.id, role: "VIEWER" });
    expect((await lead.c.del(`/api/projects/${p.id}/members/${ed.id}?handoverTo=${viewer.id}`)).status).toBe(409); // a Viewer cannot take tasks
    expect((await lead.c.del(`/api/projects/${p.id}/members/${ed.id}?handoverTo=${extra.id}`)).status).toBe(204);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(extra.id);
    expect((await ed.c.get(`/api/projects/${p.id}`)).status).toBe(404);
  });

  it("demotion to Viewer needs a taker; the Leader cannot be removed or demoted here", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(ed, p.id);
    expect((await lead.c.patch(`/api/projects/${p.id}/members/${ed.id}`, { role: "VIEWER" })).status).toBe(409);
    expect((await lead.c.patch(`/api/projects/${p.id}/members/${ed.id}`, { role: "VIEWER", handoverTo: lead.id })).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(lead.id);
    expect((await lead.c.del(`/api/projects/${p.id}/members/${lead.id}`)).status).toBe(409);
    expect((await lead.c.patch(`/api/projects/${p.id}/members/${lead.id}`, { role: "VIEWER" })).status).toBe(409);
  });

  it("hands over leadership in one step, keeping exactly one Leader", async () => {
    const lead = await account("lead");
    const next = await account("next");
    const out = await account("outsider");
    const p = await project(lead, lead, [{ who: next }]);
    expect((await lead.c.post(`/api/projects/${p.id}/leader`, { newLeaderId: out.id })).status).toBe(400); // not a member
    expect((await next.c.post(`/api/projects/${p.id}/leader`, { newLeaderId: next.id })).status).toBe(403);
    expect((await lead.c.post(`/api/projects/${p.id}/leader`, { newLeaderId: next.id })).status).toBe(200);
    const members = (await next.c.get(`/api/projects/${p.id}`)).json.project.members as { userId: string; role: string }[];
    expect(members.filter((m) => m.role === "LEADER").map((m) => m.userId)).toEqual([next.id]);
    expect(members.find((m) => m.userId === lead.id)!.role).toBe("EDITOR");
  });

  it("makes a leaving Leader hand over tasks first when they become Viewer or leave", async () => {
    const lead = await account("lead");
    const next = await account("next");
    const p = await project(lead, lead, [{ who: next }]);
    const t = await task(lead, p.id);
    expect((await lead.c.post(`/api/projects/${p.id}/leader`, { newLeaderId: next.id, previousRole: "REMOVE" })).status).toBe(409);
    expect((await lead.c.post(`/api/projects/${p.id}/leader`, { newLeaderId: next.id, previousRole: "REMOVE", handoverTo: next.id })).status).toBe(200);
    expect((await next.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(next.id);
    expect((await lead.c.get(`/api/projects/${p.id}`)).status).toBe(404);
  });

  it("refuses Viewer writes and every write once archived, but keeps reads", async () => {
    const lead = await account("lead");
    const viewer = await account("viewer");
    const p = await project(lead, lead, [{ who: viewer, role: "VIEWER" }]);
    const t = await task(lead, p.id);
    expect((await viewer.c.post(`/api/projects/${p.id}/tasks`, { title: "x" })).status).toBe(403);
    expect((await patchTask(viewer, t, { title: "x" })).status).toBe(403);
    expect((await viewer.c.del(`/api/tasks/${t}`)).status).toBe(403);
    expect((await viewer.c.get(`/api/tasks/${t}`)).status).toBe(200);
    const arch = await lead.c.post(`/api/projects/${p.id}/archive`);
    expect(arch.json.openTasks).toBe(1);
    expect((await lead.c.post(`/api/projects/${p.id}/tasks`, { title: "x" })).status).toBe(409);
    expect((await patchTask(lead, t, { title: "x" })).status).toBe(409);
    expect((await lead.c.get(`/api/tasks/${t}`)).status).toBe(200);
    expect((await lead.c.get("/api/projects")).json.projects.some((x: { id: string }) => x.id === p.id)).toBe(false);
    expect((await lead.c.get("/api/projects?archived=true")).json.projects.some((x: { id: string }) => x.id === p.id)).toBe(true);
    expect((await viewer.c.post(`/api/projects/${p.id}/unarchive`)).status).toBe(403);
    expect((await lead.c.post(`/api/projects/${p.id}/unarchive`)).status).toBe(200);
    expect((await patchTask(lead, t, { title: "now ok" })).status).toBe(200);
  });
});

describe("sections (5.4)", () => {
  it("lets only the Leader or an Admin manage Sections, up to 8", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    expect((await ed.c.post(`/api/projects/${p.id}/sections`, { name: "Nope" })).status).toBe(403);
    expect((await sa.c.post(`/api/projects/${p.id}/sections`, { name: "Client review" })).status).toBe(201);
    for (let i = 0; i < 4; i++) expect((await lead.c.post(`/api/projects/${p.id}/sections`, { name: "S" + i })).status).toBe(201);
    expect((await lead.c.post(`/api/projects/${p.id}/sections`, { name: "Ninth" })).status).toBe(409);
    expect((await lead.c.get(`/api/projects/${p.id}`)).json.project.sections).toHaveLength(8);
  });

  it("requires a destination on delete, and protects the done and last Sections", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const t = await task(lead, p.id, { sectionId: p.doing });
    expect((await lead.c.del(`/api/projects/${p.id}/sections/${p.doing}`)).status).toBe(400);
    expect((await lead.c.del(`/api/projects/${p.id}/sections/${p.done}?moveTo=${p.todo}`)).status).toBe(409);
    expect((await lead.c.patch(`/api/projects/${p.id}/sections/${p.done}`, { isDone: false })).status).toBe(409);
    expect((await lead.c.del(`/api/projects/${p.id}/sections/${p.doing}?moveTo=${p.todo}`)).status).toBe(204);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.sectionId).toBe(p.todo);
  });

  it("closes open subtasks with their parent when a section becomes the done section or is deleted into it, one log row each (SHO-BUG-3)", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const parent = await task(lead, p.id, { title: "Parent", sectionId: p.doing });
    const subs = [await task(lead, p.id, { parentId: parent }), await task(lead, p.id, { parentId: parent })];
    const all = [parent, ...subs].sort();
    const completedAt = async (id: string) => (await lead.c.get(`/api/tasks/${id}`)).json.task.completedAt as string | null;
    const completedRows = async (since: Date) => (await db.actionLog.findMany({ where: { projectId: p.id, action: "task.completed", createdAt: { gte: since } } })).map((r) => r.targetId).sort();

    // "In progress" becomes the done section: the parent and both subtasks close, a task.completed row each.
    let since = new Date();
    const r = await lead.c.patch(`/api/projects/${p.id}/sections/${p.doing}`, { isDone: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (const id of all) expect(await completedAt(id)).not.toBeNull();
    expect(await completedRows(since)).toEqual(all);
    expect((await lead.c.get(`/api/tasks/${parent}`)).json.task.subtasks).toEqual({ total: 2, open: 0 });
    // Undo reopens all three and puts the done flag back.
    expect((await lead.c.post(`/api/actions/${r.headers.get("x-undo-id")}/undo`)).status).toBe(200);
    for (const id of all) expect(await completedAt(id)).toBeNull();
    expect((await lead.c.get(`/api/projects/${p.id}`)).json.project.sections.find((s: { isDone: boolean }) => s.isDone).id).toBe(p.done);

    // Deleting "In progress" into the done section does the same.
    since = new Date();
    expect((await lead.c.del(`/api/projects/${p.id}/sections/${p.doing}?moveTo=${p.done}`)).status).toBe(204);
    for (const id of all) expect(await completedAt(id)).not.toBeNull();
    expect(await completedRows(since)).toEqual(all);
    expect((await lead.c.get(`/api/tasks/${parent}`)).json.task.sectionId).toBe(p.done);
  });

  it("restores every task when a done-section change affects more than 200 (APL-2680)", async () => {
    const OVER = 201; // one past the old cap on reopened, completed and subtask id lists
    const lead = await account("lead");
    const p = await project(lead, lead);
    const proj = await db.project.findUniqueOrThrow({ where: { id: p.id }, select: { workspaceId: true } });
    const base = { workspaceId: proj.workspaceId, projectId: p.id, assigneeId: lead.id, createdById: lead.id };
    await db.task.createMany({
      data: Array.from({ length: OVER }, (_, i) => ({ ...base, sectionId: p.done, title: `was done ${i}`, completedAt: new Date("2026-01-15T00:00:00Z"), position: i })),
    });
    await db.task.createMany({
      data: Array.from({ length: OVER }, (_, i) => ({ ...base, sectionId: p.doing, title: `will close ${i}`, position: i })),
    });
    const parents = await db.task.findMany({ where: { projectId: p.id, sectionId: p.doing, parentId: null }, select: { id: true }, orderBy: { position: "asc" } });
    expect(parents).toHaveLength(OVER);
    await db.task.createMany({
      data: parents.map((parent, i) => ({ ...base, sectionId: p.doing, parentId: parent.id, title: `sub ${i}`, position: i })),
    });

    const r = await lead.c.patch(`/api/projects/${p.id}/sections/${p.doing}`, { isDone: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const logId = r.headers.get("x-undo-id");
    const row = await db.actionLog.findUniqueOrThrow({ where: { id: logId! } });
    const before = row.beforeState as { reopenedTaskIds: string[] };
    const after = row.afterState as { completedTaskIds: string[]; completedSubtaskIds: string[]; reopened: number; completed: number; completedSubtasks: number };
    expect(before.reopenedTaskIds).toHaveLength(OVER);
    expect(after.completedTaskIds).toHaveLength(OVER);
    expect(after.completedSubtaskIds).toHaveLength(OVER);
    expect(after).toMatchObject({ reopened: OVER, completed: OVER, completedSubtasks: OVER });

    const count = (title: string, open: boolean) => db.task.count({ where: { projectId: p.id, title: { startsWith: title }, completedAt: open ? null : { not: null } } });
    expect(await count("was done ", true)).toBe(OVER);
    expect(await count("will close ", false)).toBe(OVER);
    expect(await count("sub ", false)).toBe(OVER);

    const u = await lead.c.post(`/api/actions/${logId}/undo`);
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(await count("was done ", false)).toBe(OVER);
    expect(await count("will close ", true)).toBe(OVER);
    expect(await count("sub ", true)).toBe(OVER);
    expect((await lead.c.get(`/api/projects/${p.id}`)).json.project.sections.find((s: { isDone: boolean }) => s.isDone).id).toBe(p.done);
  }, 120000);

  it("refuses a capped done-section record and leaves every task as it is (APL-2680)", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const reopened = [await task(lead, p.id, { title: "old a", sectionId: p.todo }), await task(lead, p.id, { title: "old b", sectionId: p.todo })];
    for (const id of reopened) expect((await lead.c.post(`/api/tasks/${id}/complete`, await withVersion(lead, id))).status).toBe(200);
    const closing = [
      await task(lead, p.id, { title: "new a", sectionId: p.doing }),
      await task(lead, p.id, { title: "new b", sectionId: p.doing }),
      await task(lead, p.id, { title: "new c", sectionId: p.doing }),
    ];
    const r = await lead.c.patch(`/api/projects/${p.id}/sections/${p.doing}`, { isDone: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const logId = r.headers.get("x-undo-id")!;
    const row = await db.actionLog.findUniqueOrThrow({ where: { id: logId } });
    const after = row.afterState as { completedTaskIds: string[] };
    expect(after.completedTaskIds).toHaveLength(3);
    // The shape the old cap left behind: the count says 3, the list keeps 1.
    await db.actionLog.update({ where: { id: logId }, data: { afterState: { ...after, completedTaskIds: after.completedTaskIds.slice(0, 1) } } });

    const stamp = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id }, select: { completedAt: true } })).completedAt?.toISOString() ?? null;
    const beforeUndo = await Promise.all([...reopened, ...closing].map(stamp));
    const u = await lead.c.post(`/api/actions/${logId}/undo`, { anyway: true });
    expect(u.status, JSON.stringify(u.json)).toBe(409);
    expect(u.json.error).toBe("Undo was not applied. This record lists only 1 of 3 completed tasks, so nothing was changed.");
    expect(await Promise.all([...reopened, ...closing].map(stamp))).toEqual(beforeUndo);
    expect((await db.actionLog.findUniqueOrThrow({ where: { id: logId } })).undoneAt).toBeNull();
    expect((await lead.c.get(`/api/projects/${p.id}`)).json.project.sections.find((s: { isDone: boolean }) => s.isDone).id).toBe(p.doing);
  });
});

describe("tasks (4.x, 5.x)", () => {
  it("creates tasks assigned to the creator, in due-date order with undated last, and one level of subtasks", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const late = await task(lead, p.id, { title: "late", dueDate: istDate(20) });
    const none = await task(lead, p.id, { title: "none" });
    const soon = await task(lead, p.id, { title: "soon", dueDate: istDate(2) });
    const got = (await lead.c.get(`/api/tasks/${soon}`)).json.task;
    expect(got.assignee.id).toBe(lead.id);
    expect(got.sectionId).toBe(p.todo);
    const list = (await lead.c.get(`/api/projects/${p.id}/tasks`)).json.sections[0];
    expect(list.tasks.map((t: { id: string }) => t.id)).toEqual([soon, late, none]);
    const sub = await task(lead, p.id, { parentId: soon, title: "sub" });
    expect((await lead.c.get(`/api/tasks/${sub}`)).json.task.assignee.id).toBe(lead.id);
    expect((await lead.c.post(`/api/projects/${p.id}/tasks`, { title: "deep", parentId: sub })).status).toBe(400);
    expect((await lead.c.post(`/api/projects/${p.id}/tasks`, { title: "" })).status).toBe(400);
  });

  it("pages large Sections without losing order, and shows 10 done tasks with a way to the rest", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await task(lead, p.id, { title: "t" + i, dueDate: istDate(i + 1) }));
    const first = (await lead.c.get(`/api/projects/${p.id}/tasks?sectionId=${p.todo}&limit=5`)).json.sections[0];
    expect(first.tasks).toHaveLength(5);
    const second = (await lead.c.get(`/api/projects/${p.id}/tasks?sectionId=${p.todo}&limit=5&cursor=${first.nextCursor}`)).json.sections[0];
    expect([...first.tasks, ...second.tasks].map((t: { id: string }) => t.id)).toEqual(ids.slice(0, 10));
    for (const id of ids) expect((await lead.c.post(`/api/tasks/${id}/complete`, await withVersion(lead, id))).status).toBe(200);
    const done = (await lead.c.get(`/api/projects/${p.id}/tasks?sectionId=${p.done}`)).json.sections[0];
    expect(done.total).toBe(12);
    expect(done.tasks).toHaveLength(10);
    const all = (await lead.c.get(`/api/projects/${p.id}/tasks?sectionId=${p.done}&all=true`)).json.sections[0];
    expect(all.tasks).toHaveLength(12);
  });

  it("assigns only to active Leaders or Editors, and adds Viewers only as collaborators", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const viewer = await account("viewer");
    const outsider = await account("outsider");
    const p = await project(lead, lead, [{ who: ed }, { who: viewer, role: "VIEWER" }]);
    const t = await task(lead, p.id);
    expect((await lead.c.post(`/api/tasks/${t}/assign`, await withVersion(lead, t, { assigneeId: viewer.id }))).status).toBe(400);
    expect((await lead.c.post(`/api/tasks/${t}/assign`, await withVersion(lead, t, { assigneeId: outsider.id }))).status).toBe(400);
    expect((await lead.c.post(`/api/tasks/${t}/assign`, await withVersion(lead, t, { assigneeId: ed.id }))).status).toBe(200);
    expect((await lead.c.post(`/api/tasks/${t}/collaborators`, { userId: viewer.id })).status).toBe(201);
    expect((await lead.c.post(`/api/tasks/${t}/collaborators`, { userId: outsider.id })).status).toBe(400);
    expect((await viewer.c.post(`/api/tasks/${t}/assign`, await withVersion(viewer, t, { assigneeId: viewer.id }))).status).toBe(403);
    expect((await lead.c.post(`/api/projects/${p.id}/tasks`, { title: "v", assigneeId: viewer.id })).status).toBe(400);
  });

  it("refuses a stale save and names who changed the task", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(lead, p.id);
    const seen = (await ed.c.get(`/api/tasks/${t}`)).json.task.updatedAt;
    expect((await patchTask(lead, t, { dueDate: istDate(3) })).status).toBe(200);
    const r = await ed.c.patch(`/api/tasks/${t}`, { title: "mine", expectedUpdatedAt: seen });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: { code: "version_conflict", message: "Lead changed this task while you were editing it." } });
    expect((await ed.c.get(`/api/tasks/${t}`)).json.task.dueDate).toBe(istDate(3));
    const fresh = (await ed.c.get(`/api/tasks/${t}`)).json.task.updatedAt;
    expect((await ed.c.patch(`/api/tasks/${t}`, { title: "mine", expectedUpdatedAt: fresh })).status).toBe(200);
  });

  // SHO-BUG-13: an edit must say which version it was made on.
  it("refuses an edit without a version and changes nothing", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const t = await task(lead, p.id, { title: "Original", priority: "LOW" });
    const before = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    const r = await lead.c.patch(`/api/tasks/${t}`, { title: "Overwritten", priority: "URGENT" });
    expect(r.status).toBe(400);
    const after = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect(after.title).toBe("Original");
    expect(after.priority).toBe("LOW");
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(await db.actionLog.count({ where: { targetType: "task", targetId: t, action: "task.updated" } })).toBe(0);
  });

  it("refuses a stale version with 409 and the current values", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(lead, p.id, { title: "Original" });
    const seen = (await ed.c.get(`/api/tasks/${t}`)).json.task.updatedAt;
    expect((await patchTask(lead, t, { title: "Theirs" })).status).toBe(200);
    const r = await ed.c.patch(`/api/tasks/${t}`, { title: "Mine", expectedUpdatedAt: seen });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: { code: "version_conflict", message: "Lead changed this task while you were editing it." } });
    expect((await ed.c.get(`/api/tasks/${t}`)).json.task.title).toBe("Theirs");
  });

  it("saves an edit made on the current version", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const t = await task(lead, p.id, { title: "Original" });
    const seen = (await lead.c.get(`/api/tasks/${t}`)).json.task.updatedAt;
    const r = await lead.c.patch(`/api/tasks/${t}`, { title: "Saved", expectedUpdatedAt: seen });
    expect(r.status).toBe(200);
    expect(r.json.task.title).toBe("Saved");
  });

  it("flags Blocked with a reason, keeps the Section, and tells the Leader once", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(ed, p.id, { sectionId: p.doing });
    const r = await patchTask(ed, t, { blocked: true, blockedReason: "Waiting on data" });
    expect(r.json.task.blocked).toBe(true);
    expect(r.json.task.blockedReason).toBe("Waiting on data");
    expect(r.json.task.sectionId).toBe(p.doing);
    const cleared = await patchTask(ed, t, { blocked: false });
    expect(cleared.json.task.blockedReason).toBeNull();
  });

  it("qa:TC missing APL-2670 AC1 v1.4: setting or clearing Blocked with no expectedUpdatedAt is 400 version_required (supersedes APL-2494 AC2)", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(ed, p.id);
    const before = (await ed.c.get(`/api/tasks/${t}`)).json.task as { blocked: boolean; updatedAt: string };
    for (const blocked of [true, false]) {
      const r = await ed.c.patch(`/api/tasks/${t}`, { blocked });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: { code: "version_required", message: "expectedUpdatedAt is required" } });
    }
    const after = (await ed.c.get(`/api/tasks/${t}`)).json.task as { blocked: boolean; updatedAt: string };
    expect({ blocked: after.blocked, updatedAt: after.updatedAt }).toEqual({ blocked: before.blocked, updatedAt: before.updatedAt });
    // With the version it saves, as every edit does.
    expect((await patchTask(ed, t, { blocked: true })).json.task.blocked).toBe(true);
  });

  it("completes with the open-subtask choice, and reopens to the previous Section", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const t = await task(lead, p.id, { sectionId: p.doing });
    const sub = await task(lead, p.id, { parentId: t });
    const warn = await lead.c.post(`/api/tasks/${t}/complete`, await withVersion(lead, t));
    expect(warn.status).toBe(409);
    expect(warn.json.needsConfirm).toBe("open_subtasks");
    expect((await lead.c.post(`/api/tasks/${t}/complete`, await withVersion(lead, t, { completeAll: true }))).status).toBe(200);
    const done = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect(done.sectionId).toBe(p.done);
    expect(done.completedAt).not.toBeNull();
    expect((await lead.c.get(`/api/tasks/${sub}`)).json.task.completedAt).not.toBeNull();
    expect((await lead.c.post(`/api/tasks/${sub}/reopen`)).status).toBe(409); // parent still complete
    expect((await lead.c.post(`/api/tasks/${t}/reopen`)).status).toBe(200);
    const back = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect(back.sectionId).toBe(p.doing);
    expect(back.completedAt).toBeNull();
  });

  it("completes by dragging to Done and reopens by dragging out, honouring who may close", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const viewer = await account("viewer");
    const p = await project(lead, lead, [{ who: ed }, { who: viewer, role: "VIEWER" }]);
    const t = await task(ed, p.id);
    expect((await viewer.c.post(`/api/tasks/${t}/move`, await withVersion(viewer, t, { sectionId: p.done }))).status).toBe(403);
    expect((await ed.c.post(`/api/tasks/${t}/move`, await withVersion(ed, t, { sectionId: p.done }))).status).toBe(200);
    expect((await ed.c.get(`/api/tasks/${t}`)).json.task.completedAt).not.toBeNull();
    expect((await ed.c.post(`/api/tasks/${t}/move`, await withVersion(ed, t, { sectionId: p.doing }))).status).toBe(200);
    const t2 = (await ed.c.get(`/api/tasks/${t}`)).json.task;
    expect(t2.completedAt).toBeNull();
    expect(t2.sectionId).toBe(p.doing);
  });
});

// APL-2668: assign, move, complete and approver say which version they were made on, like PATCH does (SHO-BUG-13).
describe("a version on assign, move, complete and approver (APL-2668)", () => {
  type Res = { status: number; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  type Shown = any; // eslint-disable-line @typescript-eslint/no-explicit-any
  async function setup() {
    const lead = await account("lead");
    const ed = await account("editor");
    const other = await account("other");
    const p = await project(lead, lead, [{ who: ed }, { who: other }]);
    const t = await task(lead, p.id, { title: "Original", assigneeId: other.id }); // the Leader may set its approver
    return { lead, ed, other, p, t };
  }
  type S = Awaited<ReturnType<typeof setup>>;
  // Each mutation: how the screen sends it, and how to tell it took effect.
  const MUTATIONS: Record<string, { send: (s: S, body: Record<string, unknown>) => Promise<Res>; body: (s: S) => Record<string, unknown>; applied: (s: S, t: Shown) => boolean }> = {
    assign: { send: (s, b) => s.lead.c.post(`/api/tasks/${s.t}/assign`, b), body: (s) => ({ assigneeId: s.ed.id }), applied: (s, t) => t.assignee.id === s.ed.id },
    move: { send: (s, b) => s.lead.c.post(`/api/tasks/${s.t}/move`, b), body: (s) => ({ sectionId: s.p.doing }), applied: (s, t) => t.section.id === s.p.doing },
    complete: { send: (s, b) => s.lead.c.post(`/api/tasks/${s.t}/complete`, b), body: () => ({}), applied: (_s, t) => !!t.completedAt },
    setApprover: { send: (s, b) => s.lead.c.put(`/api/tasks/${s.t}/approver`, b), body: (s) => ({ approverId: s.ed.id }), applied: (s, t) => t.approver?.id === s.ed.id },
  };
  const shown = async (s: S) => (await s.lead.c.get(`/api/tasks/${s.t}`)).json.task;
  const logs = (id: string) => db.actionLog.count({ where: { targetType: "task", targetId: id } });

  for (const [name, m] of Object.entries(MUTATIONS)) {
    it(`${name}: refuses a call without a version with 400 and changes nothing`, async () => {
      const s = await setup();
      const before = await shown(s);
      const rows = await logs(s.t);
      const r = await m.send(s, m.body(s));
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: { code: "version_required", message: "expectedUpdatedAt is required" } });
      const after = await shown(s);
      expect(m.applied(s, after)).toBe(false);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(await logs(s.t)).toBe(rows);
    });

    it(`${name}: refuses a stale version with 409, who changed it and the current values`, async () => {
      const s = await setup();
      const seen = (await shown(s)).updatedAt;
      expect((await patchTask(s.other, s.t, { title: "Theirs" })).status).toBe(200);
      const r = await m.send(s, { ...m.body(s), expectedUpdatedAt: seen });
      expect(r.status).toBe(409);
      expect(r.json).toEqual({ error: { code: "version_conflict", message: "Other changed this task while you were editing it." } });
      expect((await shown(s)).title).toBe("Theirs");
      expect(m.applied(s, await shown(s))).toBe(false);
    });

    it(`${name}: saves a change made on the current version`, async () => {
      const s = await setup();
      const r = await m.send(s, { ...m.body(s), expectedUpdatedAt: (await shown(s)).updatedAt });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(m.applied(s, await shown(s))).toBe(true);
    });
  }

  it("the lib functions bulk and the concierge call refuse an empty version with 400 and change nothing", async () => {
    const s = await setup();
    const me = { id: s.lead.id, orgRole: "MEMBER" as const };
    const before = await shown(s);
    const rows = await logs(s.t);
    for (const call of [
      () => assignTask(me, s.t, s.ed.id, ""),
      () => moveTask(me, s.t, s.p.doing, ""),
      () => completeTask(me, s.t, ""),
      () => setApprover(me, s.t, s.ed.id, ""),
    ]) await expect(call()).rejects.toMatchObject({ status: 400, code: "invalid_version", message: "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone." });
    expect((await shown(s)).updatedAt).toBe(before.updatedAt);
    expect(await logs(s.t)).toBe(rows);
  });

  it("the concierge sends the version each task is at when it applies assign, move, approver and complete", async () => {
    const s = await setup();
    const me = { id: s.lead.id, orgRole: "MEMBER" as const };
    await execute(me, [
      { k: "task.assign", taskId: s.t, assigneeId: s.ed.id },
      { k: "task.section", taskId: s.t, sectionId: s.p.doing },
      { k: "task.approver", taskId: s.t, approverId: s.other.id },
    ]);
    let t = await shown(s);
    expect([t.assignee.id, t.section.id, t.approver?.id]).toEqual([s.ed.id, s.p.doing, s.other.id]);
    await execute({ id: s.other.id, orgRole: "MEMBER" }, [{ k: "task.complete", taskId: s.t }]); // with an approver, only the approver closes
    t = await shown(s);
    expect(t.completedAt).not.toBeNull();
  });

  for (const action of ["assign", "move", "complete"] as const) {
    const extra = (s: S) => (action === "assign" ? { assigneeId: s.ed.id } : action === "move" ? { sectionId: s.p.doing } : {});
    const applied = (s: S, t: Shown) => (action === "assign" ? t.assignee.id === s.ed.id : action === "move" ? t.section.id === s.p.doing : !!t.completedAt);

    it(`bulk ${action}: refuses a request missing a version for any task with 400 and changes nothing`, async () => {
      const s = await setup();
      const t2 = await task(s.lead, s.p.id);
      const rows = await logs(s.t);
      const none = await s.lead.c.post(`/api/projects/${s.p.id}/tasks/bulk`, { taskIds: [s.t, t2], action, ...extra(s) });
      expect(none.status).toBe(400);
      expect(none.json.error).toBe("expectedUpdatedAt is required");
      const one = await s.lead.c.post(`/api/projects/${s.p.id}/tasks/bulk`, { taskIds: [s.t, t2], versions: { [s.t]: (await shown(s)).updatedAt }, action, ...extra(s) });
      expect(one.status).toBe(400);
      for (const id of [s.t, t2]) expect(applied(s, (await s.lead.c.get(`/api/tasks/${id}`)).json.task)).toBe(false);
      expect(await logs(s.t)).toBe(rows);
    });

    it(`bulk ${action}: a task changed since the page showed it lands in skipped; the rest save`, async () => {
      const s = await setup();
      const t2 = await task(s.lead, s.p.id);
      const body = await bulkWithVersions(s.lead, [s.t, t2], { action, ...extra(s) });
      expect((await patchTask(s.other, s.t, { title: "Theirs" })).status).toBe(200);
      const r = await s.lead.c.post(`/api/projects/${s.p.id}/tasks/bulk`, body);
      expect(r.status).toBe(200);
      expect(r.json.changed).toBe(1);
      expect(r.json.skipped).toEqual([{ id: s.t, title: "Theirs", reason: "changed by someone else" }]);
      expect(r.json.message).toBe("1 changed, 1 skipped (changed by someone else)");
      expect(applied(s, await shown(s))).toBe(false);
      expect(applied(s, (await s.lead.c.get(`/api/tasks/${t2}`)).json.task)).toBe(true);
    });
  }
});

describe("approver (4.6)", () => {
  async function setup() {
    const lead = await account("lead");
    const worker = await account("worker");
    const boss = await account("approver");
    const other = await account("other");
    const p = await project(lead, lead, [{ who: worker }, { who: boss }, { who: other }]);
    const t = await task(worker, p.id, { title: "needs review" });
    return { lead, worker, boss, other, p, t };
  }

  it("sets an approver, limits who may, and rejects the assignee as approver", async () => {
    const { lead, worker, boss, other, p, t } = await setup();
    expect((await worker.c.put(`/api/tasks/${t}/approver`, await withVersion(worker, t, { approverId: boss.id }))).status).toBe(403); // the assignee
    expect((await other.c.put(`/api/tasks/${t}/approver`, await withVersion(other, t, { approverId: boss.id }))).status).toBe(403); // not Leader or creator
    expect((await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: worker.id }))).status).toBe(400); // is the assignee
    const viewer = await account("viewer");
    await lead.c.post(`/api/projects/${p.id}/members`, { userId: viewer.id, role: "VIEWER" });
    expect((await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: viewer.id }))).status).toBe(400);
    expect((await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: boss.id }))).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.approver.id).toBe(boss.id);
  });

  it("restricts the assignee to handing over to the approver, who then closes or sends back", async () => {
    const { lead, worker, boss, other, p, t } = await setup();
    await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: boss.id }));
    expect((await worker.c.post(`/api/tasks/${t}/assign`, await withVersion(worker, t, { assigneeId: other.id }))).status).toBe(403);
    expect((await worker.c.post(`/api/tasks/${t}/complete`, await withVersion(worker, t))).status).toBe(403);
    expect((await other.c.post(`/api/tasks/${t}/complete`, await withVersion(other, t))).status).toBe(403); // another Editor
    expect((await other.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(403);
    expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    const held = (await boss.c.get(`/api/tasks/${t}`)).json.task;
    expect(held.assignee.id).toBe(boss.id);
    expect(held.awaitingApproval).toBe(true);
    // SHO-US-14.16: a task held for approval is listed in "Waiting on me", no longer under Later.
    const mineNow = (await boss.c.get("/api/my-tasks")).json;
    expect(mineNow.waitingOnMe.some((x: { id: string }) => x.id === t)).toBe(true);
    expect(mineNow.later.some((x: { id: string }) => x.id === t)).toBe(false);
    expect((await other.c.post(`/api/tasks/${t}/send-back`)).status).toBe(403);
    expect((await boss.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
    expect((await boss.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(worker.id);
    await worker.c.post(`/api/tasks/${t}/send-for-approval`);
    expect((await boss.c.post(`/api/tasks/${t}/move`, await withVersion(boss, t, { sectionId: p.done }))).status).toBe(200);
    expect((await boss.c.get(`/api/tasks/${t}`)).json.task.completedAt).not.toBeNull();
  });

  it("lets only the Leader or an Admin change the approver mid-approval, and the new approver becomes the holder", async () => {
    const { lead, worker, boss, other, t } = await setup();
    await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: boss.id }));
    await worker.c.post(`/api/tasks/${t}/send-for-approval`);
    expect((await boss.c.put(`/api/tasks/${t}/approver`, await withVersion(boss, t, { approverId: other.id }))).status).toBe(403);
    expect((await worker.c.put(`/api/tasks/${t}/approver`, await withVersion(worker, t, { approverId: other.id }))).status).toBe(403);
    expect((await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: other.id }))).status).toBe(200);
    const now = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect(now.assignee.id).toBe(other.id);
    expect(now.approver.id).toBe(other.id);
  });

  it("sends back to the Leader when the previous assignee has gone", async () => {
    const { lead, worker, boss, p, t } = await setup();
    await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: boss.id }));
    await worker.c.post(`/api/tasks/${t}/send-for-approval`);
    expect((await lead.c.del(`/api/projects/${p.id}/members/${worker.id}?handoverTo=${lead.id}`)).status).toBe(204);
    expect((await boss.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(lead.id);
  });

  it("clears the approver when a send-back can only go to the Leader who approves, so the task is not stuck (SHO-BUG-6)", async () => {
    const sa = await superAdmin();
    const { lead, worker, boss, other, p, t } = await setup();
    const get = async () => (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect((await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: lead.id }))).status).toBe(200);
    expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    expect((await lead.c.del(`/api/projects/${p.id}/members/${worker.id}?handoverTo=${other.id}`)).status).toBe(204);
    // Nobody to send back to: the Leader holds it, approves nothing of their own, and can act on it.
    const sb = await lead.c.post(`/api/tasks/${t}/send-back`);
    expect(sb.status, JSON.stringify(sb.json)).toBe(200);
    expect(await get()).toMatchObject({ assignee: { id: lead.id }, approver: null, awaitingApproval: false, previousAssigneeId: null });
    const row = await db.actionLog.findUniqueOrThrow({ where: { id: sb.headers.get("x-undo-id")! } });
    expect(row.beforeState).toMatchObject({ assigneeId: lead.id, approverId: lead.id });
    expect(row.afterState).toMatchObject({ assigneeId: lead.id, approverId: null });
    // Undo restores the approver, and with it the waiting state.
    expect((await lead.c.post(`/api/actions/${row.id}/undo`)).status).toBe(200);
    expect(await get()).toMatchObject({ assignee: { id: lead.id }, approver: { id: lead.id }, awaitingApproval: true });
    // An Admin sending it back clears it the same way, and the Leader's notice says so.
    expect((await sa.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
    expect(await get()).toMatchObject({ approver: null, awaitingApproval: false });
    const notes = (await lead.c.get("/api/notifications")).json.items as { text: string }[];
    expect(notes.some((n) => n.text === 'Root sent "needs review" back to you. It no longer has an approver.')).toBe(true);
    // From there the Leader can reassign it and name an approver again.
    expect((await lead.c.post(`/api/tasks/${t}/assign`, await withVersion(lead, t, { assigneeId: other.id }))).status).toBe(200);
    expect((await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: boss.id }))).status).toBe(200);
  });

  it("lets the Leader hand on a task they hold even though it has an approver; an Editor still cannot (SHO-BUG-6)", async () => {
    const { lead, worker, boss, other, p } = await setup();
    const t = await task(lead, p.id, { title: "Leader holds", assigneeId: lead.id, approverId: boss.id });
    expect((await lead.c.post(`/api/tasks/${t}/assign`, await withVersion(lead, t, { assigneeId: other.id }))).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task).toMatchObject({ assignee: { id: other.id }, approver: { id: boss.id }, awaitingApproval: false });
    expect((await other.c.post(`/api/tasks/${t}/assign`, await withVersion(other, t, { assigneeId: worker.id }))).status).toBe(403); // the assignee may only hand it to the approver
    expect((await other.c.post(`/api/tasks/${t}/assign`, await withVersion(other, t, { assigneeId: boss.id }))).status).toBe(200);
  });

  it("hands a removed approver's tasks to the Leader, who also becomes the holder when awaiting", async () => {
    const { lead, worker, boss, p, t } = await setup();
    const t2 = await task(worker, p.id);
    await lead.c.put(`/api/tasks/${t}/approver`, await withVersion(lead, t, { approverId: boss.id }));
    await lead.c.put(`/api/tasks/${t2}/approver`, await withVersion(lead, t2, { approverId: boss.id }));
    await worker.c.post(`/api/tasks/${t}/send-for-approval`); // t awaits boss, t2 does not
    expect((await lead.c.del(`/api/projects/${p.id}/members/${boss.id}`)).status).toBe(409); // boss holds t: needs a taker
    expect((await lead.c.del(`/api/projects/${p.id}/members/${boss.id}?handoverTo=${lead.id}`)).status).toBe(204);
    const held = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect(held.approver.id).toBe(lead.id);
    expect(held.assignee.id).toBe(lead.id); // awaiting: the Leader becomes the holder
    const other = (await lead.c.get(`/api/tasks/${t2}`)).json.task;
    expect(other.approver.id).toBe(lead.id);
    expect(other.assignee.id).toBe(worker.id);
  });
});

describe("trash (6.1, 6.2)", () => {
  it("moves a task and its subtasks to Trash, lets only the Leader restore, refuses Editors and Viewers", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const viewer = await account("viewer");
    const p = await project(lead, lead, [{ who: ed }, { who: viewer, role: "VIEWER" }]);
    const t = await task(ed, p.id, { sectionId: p.doing });
    const sub = await task(ed, p.id, { parentId: t });
    expect((await ed.c.del(`/api/tasks/${t}`)).status).toBe(204);
    expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(404);
    expect((await ed.c.get(`/api/tasks/${sub}`)).status).toBe(404);
    expect((await ed.c.get(`/api/projects/${p.id}/tasks`)).json.sections[1].tasks).toHaveLength(0);
    const trash = (await viewer.c.get(`/api/projects/${p.id}/trash`)).json.items;
    expect(trash).toHaveLength(1);
    expect(trash[0].daysLeft).toBe(30);
    expect(trash[0].deletedBy.name).toBe("Editor");
    expect((await viewer.c.post(`/api/tasks/${t}/restore`)).status).toBe(403);
    expect((await ed.c.post(`/api/tasks/${t}/restore`)).status).toBe(403);
    expect((await lead.c.post(`/api/tasks/${t}/restore`)).status).toBe(200);
    expect((await ed.c.get(`/api/tasks/${t}`)).json.task.sectionId).toBe(p.doing);
    expect((await ed.c.get(`/api/tasks/${sub}`)).status).toBe(200);
  });

  it("lists a subtask deleted on its own even when its parent is later in Trash, but not one deleted together with its parent", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead, []);
    const t = await task(lead, p.id);
    const early = await task(lead, p.id, { parentId: t });
    const together = await task(lead, p.id, { parentId: t });
    expect((await lead.c.del(`/api/tasks/${early}`)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 15)); // a later timestamp for the parent's own deletion
    expect((await lead.c.del(`/api/tasks/${t}`)).status).toBe(204);
    const items = (await lead.c.get(`/api/projects/${p.id}/trash`)).json.items as { id: string; isSubtask: boolean; parentTitle: string | null }[];
    expect(items.map((i) => i.id).sort()).toEqual([t, early].sort());
    expect(items.find((i) => i.id === early)?.isSubtask).toBe(true);
    expect(items.find((i) => i.id === early)?.parentTitle).toBeTruthy();
    expect(items.some((i) => i.id === together)).toBe(false);
  });

  it("restores a deleted parent with its subtask after a confirmation", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const t = await task(lead, p.id);
    const sub = await task(lead, p.id, { parentId: t });
    await lead.c.del(`/api/tasks/${t}`);
    const r = await lead.c.post(`/api/tasks/${sub}/restore`);
    expect(r.status).toBe(409);
    expect(r.json.needsConfirm).toBe("parent");
    expect((await lead.c.post(`/api/tasks/${sub}/restore`, { confirmParent: true })).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).status).toBe(200);
  });

  it("restores to the Leader when the assignee has been deactivated, and purges only after 30 days", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(ed, p.id);
    await lead.c.del(`/api/tasks/${t}`);
    await sa.c.post(`/api/team/${ed.id}/deactivate`, { reassign: "leaders" });
    expect((await lead.c.post(`/api/tasks/${t}/restore`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(lead.id);
    expect((await new Client().post("/api/jobs/purge-trash")).status).toBe(401);
  });

  it("also moves a restored subtask to the Leader when its assignee was deactivated while it sat in Trash", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(lead, p.id);
    const sub = await task(ed, p.id, { parentId: t });
    await lead.c.del(`/api/tasks/${t}`);
    await sa.c.post(`/api/team/${ed.id}/deactivate`, { reassign: "leaders" });
    expect((await lead.c.post(`/api/tasks/${t}/restore`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${sub}`)).json.task.assignee.id).toBe(lead.id);
  });
});

describe("My tasks (5.1)", () => {
  it("groups by due date, tags collaborations, hides Viewer ticks, removed projects and archived projects", async () => {
    const lead = await account("lead");
    const me = await account("me");
    const viewer = await account("viewer");
    const p = await project(lead, lead, [{ who: me }, { who: viewer, role: "VIEWER" }]);
    const q = await project(lead, lead, [{ who: me }]);
    const overdue = await task(lead, p.id, { assigneeId: me.id, dueDate: istDate(-2) });
    const soon = await task(lead, p.id, { assigneeId: me.id, dueDate: istDate(3) });
    const later = await task(lead, p.id, { assigneeId: me.id, dueDate: istDate(30) });
    const collab = await task(lead, p.id, { collaboratorIds: [me.id, viewer.id], dueDate: istDate(1) });
    const inQ = await task(lead, q.id, { assigneeId: me.id });
    const mine = (await me.c.get("/api/my-tasks")).json;
    expect(mine.overdue.map((t: { id: string }) => t.id)).toEqual([overdue]);
    expect(mine.next7.map((t: { id: string }) => t.id)).toEqual([collab, soon]);
    expect(mine.later.map((t: { id: string }) => t.id).sort()).toEqual([later, inQ].sort());
    const c = mine.next7.find((t: { id: string }) => t.id === collab);
    expect(c.relation).toBe("COLLABORATOR");
    expect(c.project.name).toBeTruthy();
    const v = (await viewer.c.get("/api/my-tasks")).json;
    expect(v.next7[0].canClose).toBe(false);
    await lead.c.post(`/api/projects/${q.id}/archive`);
    expect((await me.c.get("/api/my-tasks")).json.later.some((t: { id: string }) => t.id === inQ)).toBe(false);
    await lead.c.del(`/api/projects/${p.id}/members/${me.id}?handoverTo=${lead.id}`);
    const after = (await me.c.get("/api/my-tasks")).json;
    expect([...after.overdue, ...after.next7, ...after.later].some((t: { projectId: string }) => t.projectId === p.id)).toBe(false);
  });
});

export type { Account };
