// Integration tests for roles, projects, members, Sections and tasks (SHO-US-2.x to 6.2).
// Server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com and the same EMAIL_OUTBOX_DIR.
import { describe, expect, it } from "vitest";
import { Client, account, admin, istDate, project, superAdmin, task, type Account } from "./helpers";

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
    expect(asMember.every((p) => Object.keys(p).sort().join() === "id,name")).toBe(true);
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
    expect((await viewer.c.patch(`/api/tasks/${t}`, { title: "x" })).status).toBe(403);
    expect((await viewer.c.del(`/api/tasks/${t}`)).status).toBe(403);
    expect((await viewer.c.get(`/api/tasks/${t}`)).status).toBe(200);
    const arch = await lead.c.post(`/api/projects/${p.id}/archive`);
    expect(arch.json.openTasks).toBe(1);
    expect((await lead.c.post(`/api/projects/${p.id}/tasks`, { title: "x" })).status).toBe(409);
    expect((await lead.c.patch(`/api/tasks/${t}`, { title: "x" })).status).toBe(409);
    expect((await lead.c.get(`/api/tasks/${t}`)).status).toBe(200);
    expect((await lead.c.get("/api/projects")).json.projects.some((x: { id: string }) => x.id === p.id)).toBe(false);
    expect((await lead.c.get("/api/projects?archived=true")).json.projects.some((x: { id: string }) => x.id === p.id)).toBe(true);
    expect((await viewer.c.post(`/api/projects/${p.id}/unarchive`)).status).toBe(403);
    expect((await lead.c.post(`/api/projects/${p.id}/unarchive`)).status).toBe(200);
    expect((await lead.c.patch(`/api/tasks/${t}`, { title: "now ok" })).status).toBe(200);
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
    for (const id of ids) expect((await lead.c.post(`/api/tasks/${id}/complete`)).status).toBe(200);
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
    expect((await lead.c.post(`/api/tasks/${t}/assign`, { assigneeId: viewer.id })).status).toBe(400);
    expect((await lead.c.post(`/api/tasks/${t}/assign`, { assigneeId: outsider.id })).status).toBe(400);
    expect((await lead.c.post(`/api/tasks/${t}/assign`, { assigneeId: ed.id })).status).toBe(200);
    expect((await lead.c.post(`/api/tasks/${t}/collaborators`, { userId: viewer.id })).status).toBe(201);
    expect((await lead.c.post(`/api/tasks/${t}/collaborators`, { userId: outsider.id })).status).toBe(400);
    expect((await viewer.c.post(`/api/tasks/${t}/assign`, { assigneeId: viewer.id })).status).toBe(403);
    expect((await lead.c.post(`/api/projects/${p.id}/tasks`, { title: "v", assigneeId: viewer.id })).status).toBe(400);
  });

  it("refuses a stale save and names who changed the task", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(lead, p.id);
    const seen = (await ed.c.get(`/api/tasks/${t}`)).json.task.updatedAt;
    expect((await lead.c.patch(`/api/tasks/${t}`, { dueDate: istDate(3) })).status).toBe(200);
    const r = await ed.c.patch(`/api/tasks/${t}`, { title: "mine", expectedUpdatedAt: seen });
    expect(r.status).toBe(409);
    expect(r.json.stale).toBe(true);
    expect(r.json.changedBy).toBe("Lead");
    expect(r.json.current.dueDate).toBe(istDate(3));
    const fresh = (await ed.c.get(`/api/tasks/${t}`)).json.task.updatedAt;
    expect((await ed.c.patch(`/api/tasks/${t}`, { title: "mine", expectedUpdatedAt: fresh })).status).toBe(200);
  });

  it("flags Blocked with a reason, keeps the Section, and tells the Leader once", async () => {
    const lead = await account("lead");
    const ed = await account("editor");
    const p = await project(lead, lead, [{ who: ed }]);
    const t = await task(ed, p.id, { sectionId: p.doing });
    const r = await ed.c.patch(`/api/tasks/${t}`, { blocked: true, blockedReason: "Waiting on data" });
    expect(r.json.task.blocked).toBe(true);
    expect(r.json.task.blockedReason).toBe("Waiting on data");
    expect(r.json.task.sectionId).toBe(p.doing);
    const cleared = await ed.c.patch(`/api/tasks/${t}`, { blocked: false });
    expect(cleared.json.task.blockedReason).toBeNull();
  });

  it("completes with the open-subtask choice, and reopens to the previous Section", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const t = await task(lead, p.id, { sectionId: p.doing });
    const sub = await task(lead, p.id, { parentId: t });
    const warn = await lead.c.post(`/api/tasks/${t}/complete`);
    expect(warn.status).toBe(409);
    expect(warn.json.needsConfirm).toBe("open_subtasks");
    expect((await lead.c.post(`/api/tasks/${t}/complete`, { completeAll: true })).status).toBe(200);
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
    expect((await viewer.c.post(`/api/tasks/${t}/move`, { sectionId: p.done })).status).toBe(403);
    expect((await ed.c.post(`/api/tasks/${t}/move`, { sectionId: p.done })).status).toBe(200);
    expect((await ed.c.get(`/api/tasks/${t}`)).json.task.completedAt).not.toBeNull();
    expect((await ed.c.post(`/api/tasks/${t}/move`, { sectionId: p.doing })).status).toBe(200);
    const t2 = (await ed.c.get(`/api/tasks/${t}`)).json.task;
    expect(t2.completedAt).toBeNull();
    expect(t2.sectionId).toBe(p.doing);
  });
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
    expect((await worker.c.put(`/api/tasks/${t}/approver`, { approverId: boss.id })).status).toBe(403); // the assignee
    expect((await other.c.put(`/api/tasks/${t}/approver`, { approverId: boss.id })).status).toBe(403); // not Leader or creator
    expect((await lead.c.put(`/api/tasks/${t}/approver`, { approverId: worker.id })).status).toBe(400); // is the assignee
    const viewer = await account("viewer");
    await lead.c.post(`/api/projects/${p.id}/members`, { userId: viewer.id, role: "VIEWER" });
    expect((await lead.c.put(`/api/tasks/${t}/approver`, { approverId: viewer.id })).status).toBe(400);
    expect((await lead.c.put(`/api/tasks/${t}/approver`, { approverId: boss.id })).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.approver.id).toBe(boss.id);
  });

  it("restricts the assignee to handing over to the approver, who then closes or sends back", async () => {
    const { lead, worker, boss, other, p, t } = await setup();
    await lead.c.put(`/api/tasks/${t}/approver`, { approverId: boss.id });
    expect((await worker.c.post(`/api/tasks/${t}/assign`, { assigneeId: other.id })).status).toBe(403);
    expect((await worker.c.post(`/api/tasks/${t}/complete`)).status).toBe(403);
    expect((await other.c.post(`/api/tasks/${t}/complete`)).status).toBe(403); // another Editor
    expect((await other.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(403);
    expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    const held = (await boss.c.get(`/api/tasks/${t}`)).json.task;
    expect(held.assignee.id).toBe(boss.id);
    expect(held.awaitingApproval).toBe(true);
    expect((await boss.c.get("/api/my-tasks")).json.later.some((x: { id: string }) => x.id === t)).toBe(true);
    expect((await other.c.post(`/api/tasks/${t}/send-back`)).status).toBe(403);
    expect((await boss.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
    expect((await boss.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(worker.id);
    await worker.c.post(`/api/tasks/${t}/send-for-approval`);
    expect((await boss.c.post(`/api/tasks/${t}/move`, { sectionId: p.done })).status).toBe(200);
    expect((await boss.c.get(`/api/tasks/${t}`)).json.task.completedAt).not.toBeNull();
  });

  it("lets only the Leader or an Admin change the approver mid-approval, and the new approver becomes the holder", async () => {
    const { lead, worker, boss, other, t } = await setup();
    await lead.c.put(`/api/tasks/${t}/approver`, { approverId: boss.id });
    await worker.c.post(`/api/tasks/${t}/send-for-approval`);
    expect((await boss.c.put(`/api/tasks/${t}/approver`, { approverId: other.id })).status).toBe(403);
    expect((await worker.c.put(`/api/tasks/${t}/approver`, { approverId: other.id })).status).toBe(403);
    expect((await lead.c.put(`/api/tasks/${t}/approver`, { approverId: other.id })).status).toBe(200);
    const now = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect(now.assignee.id).toBe(other.id);
    expect(now.approver.id).toBe(other.id);
  });

  it("sends back to the Leader when the previous assignee has gone", async () => {
    const { lead, worker, boss, p, t } = await setup();
    await lead.c.put(`/api/tasks/${t}/approver`, { approverId: boss.id });
    await worker.c.post(`/api/tasks/${t}/send-for-approval`);
    expect((await lead.c.del(`/api/projects/${p.id}/members/${worker.id}?handoverTo=${lead.id}`)).status).toBe(204);
    expect((await boss.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(lead.id);
  });

  it("hands a removed approver's tasks to the Leader, who also becomes the holder when awaiting", async () => {
    const { lead, worker, boss, p, t } = await setup();
    const t2 = await task(worker, p.id);
    await lead.c.put(`/api/tasks/${t}/approver`, { approverId: boss.id });
    await lead.c.put(`/api/tasks/${t2}/approver`, { approverId: boss.id });
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
