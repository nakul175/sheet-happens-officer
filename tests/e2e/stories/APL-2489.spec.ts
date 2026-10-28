import { test, archiveProject } from "./qa";
// SHO-US-3.5 Hand over project leadership (Linear APL-2489).
// The Super Admin hands over to / takes over from the plain Member (SHO_MEMBER_*); those tests skip without it.
import { expect, type Api } from "../support";
import { ghost, getTask, newProject, newTask } from "../helpers/migration-2731";

const leaders = async (who: { api: Api }, id: string) =>
  ((await who.api.get(`/api/projects/${id}`)).json.project.members as { userId: string; role: string }[]).filter((m) => m.role === "LEADER");

test("AC1+AC4: the member becomes Leader, the previous Leader becomes Editor by default, in one step with one Leader", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.5 handover", members: [{ who: member }] });
  const r = await admin.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: member.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const d = (await member.api.get(`/api/projects/${p.id}`)).json.project;
  const ls = d.members.filter((m: { role: string }) => m.role === "LEADER");
  expect(ls.map((m: { userId: string }) => m.userId)).toEqual([member.user.id]);
  expect(d.members.find((m: { userId: string }) => m.userId === admin.user.id).role).toBe("EDITOR");
});

test("AC1: the previous Leader can be made a Viewer instead", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.5 viewer", members: [{ who: member }] });
  expect((await admin.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: member.user.id, previousRole: "VIEWER" })).status).toBe(200);
  const d = (await member.api.get(`/api/projects/${p.id}`)).json.project;
  expect(d.members.find((m: { userId: string }) => m.userId === admin.user.id).role).toBe("VIEWER");
  expect(d.members.filter((m: { role: string }) => m.role === "LEADER")).toHaveLength(1);
});

test("AC2: someone who is not a member cannot be made Leader", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "3.5 nonmember" });
  const out = await ghost(admin, later, "outsider");
  expect((await admin.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: out.id })).status).toBe(400);
  expect(await leaders(admin, p.id)).toHaveLength(1);
});

test("AC3: an Editor or a Viewer cannot change the Leader; an Admin can", async ({ admin, member, later }) => {
  for (const role of ["EDITOR", "VIEWER"] as const) {
    const p = await newProject(admin, later, { label: `3.5 ${role}`, members: [{ who: member, role }] });
    expect((await member.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: member.user.id })).status).toBe(403);
    expect((await leaders(admin, p.id))[0].userId).toBe(admin.user.id);
  }
  // The Member leads this one and the Super Admin is not in it: the Super Admin (an Admin) can still change its Leader.
  const q = await newProject(admin, later, { label: "3.5 admin can", creator: member, leader: member });
  const next = await ghost(admin, later, "nextlead");
  expect((await member.api.post(`/api/projects/${q.id}/members`, { userId: next.id })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${q.id}/leader`, { newLeaderId: next.id })).status).toBe(200);
  expect((await leaders(admin, q.id))[0].userId).toBe(next.id);
  later(() => archiveProject(admin.api, q.id, admin.user.id)); // restore leadership before the disposable next Leader is deactivated
});

test("AC4: handing over to the current Leader is refused and leaves exactly one Leader", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.5 same", members: [{ who: member }] });
  const r = await admin.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: admin.user.id });
  expect(r.status).toBe(400);
  expect(await leaders(admin, p.id)).toHaveLength(1);
});

test("AC5: a previous Leader with open tasks who becomes Viewer or leaves must name who takes them", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.5 tasks", members: [{ who: member }] });
  const t = await newTask(admin, p.id);
  expect((await admin.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: member.user.id, previousRole: "REMOVE" })).status).toBe(409);
  expect((await getTask(admin, t)).assignee.id).toBe(admin.user.id); // nothing moved
  expect(await leaders(admin, p.id)).toHaveLength(1);
  const ok = await admin.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: member.user.id, previousRole: "REMOVE", handoverTo: member.user.id });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect((await getTask(member, t)).assignee.id).toBe(member.user.id);
});

test("AC5: choosing Viewer in the Change leader dialog shows 'Who takes their open tasks?' (screen)", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.5 dialog", members: [{ who: member }] });
  await admin.page.goto(`/projects/${p.id}/members`);
  await admin.page.getByRole("button", { name: "Change leader…" }).click();
  const dlg = admin.page.getByRole("dialog");
  await expect(dlg.getByLabel("The current Leader becomes")).toBeVisible();
  await expect(dlg.getByText("Who takes their open tasks?")).toHaveCount(0);
  await dlg.getByLabel("The current Leader becomes").selectOption("VIEWER");
  await expect(dlg.getByText("Who takes their open tasks?")).toBeVisible();
});
