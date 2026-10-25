// SHO-US-3.4 Add and remove project members (Linear APL-2488).
// The Super Admin acts as the Leader; the plain Member (SHO_MEMBER_*) is the person added, removed or demoted.
import { test, expect } from "../support";
import { ghost, getTask, newProject, newTask } from "../g2";

test("AC1: the Leader adds an active person (Editor pre-selected); they see the project and are notified", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.4 add" });
  expect((await member.api.get(`/api/projects/${p.id}`)).status).toBe(404); // not in yet
  const r = await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id }); // no role: the default
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const d = (await member.api.get(`/api/projects/${p.id}`)).json.project;
  expect(d.members.find((m: { userId: string }) => m.userId === member.user.id).role).toBe("EDITOR");
  const mine = ((await member.api.get("/api/projects")).json.projects as { id: string }[]).map((x) => x.id);
  expect(mine).toContain(p.id);
  const notes = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  expect(notes.some((n) => n.text.includes(p.name)), "a notice naming the project").toBe(true);
});

test("AC1: the members panel finds a person by name and adds them (screen)", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.4 screen" });
  await admin.page.goto(`/projects/${p.id}/members`);
  await admin.page.getByLabel("Search by name or email").fill(String(member.user.name));
  const row = admin.page.locator(".item", { hasText: String(member.user.name) }).filter({ has: admin.page.getByRole("button", { name: "Add" }) }).first();
  await row.getByRole("button", { name: "Add" }).click();
  await expect.poll(async () => {
    const d = (await admin.api.get(`/api/projects/${p.id}`)).json.project;
    return d.members.some((m: { userId: string }) => m.userId === member.user.id);
  }, { timeout: 15_000 }).toBe(true);
  await expect(admin.page.locator(".item", { hasText: String(member.user.name) }).getByRole("combobox").first()).toBeVisible(); // now listed with a role picker
});

test("AC1: a deactivated person is not accepted as a new member", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "3.4 inactive" });
  const g = await ghost(admin, later, "inactive");
  await admin.api.post(`/api/team/${g.id}/deactivate`, { reassign: "leaders" });
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: g.id })).status).toBe(400);
});

test("AC2: an Editor or a Viewer cannot add or remove anyone", async ({ admin, member, later }) => {
  const other = await ghost(admin, later);
  for (const role of ["EDITOR", "VIEWER"] as const) {
    const p = await newProject(admin, later, { label: `3.4 ${role}`, members: [{ who: member, role }] });
    expect((await member.api.post(`/api/projects/${p.id}/members`, { userId: other.id })).status).toBe(403);
    expect((await member.api.del(`/api/projects/${p.id}/members/${admin.user.id}`)).status).toBe(403);
  }
});

test("AC3: removing a member with open tasks needs a Leader or Editor to take every task", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.4 remove", members: [{ who: member, role: "EDITOR" }] });
  const viewer = await ghost(admin, later, "viewer");
  await admin.api.post(`/api/projects/${p.id}/members`, { userId: viewer.id, role: "VIEWER" });
  const t = await newTask(member, p.id, { dueDate: "2026-11-03" });
  expect((await admin.api.del(`/api/projects/${p.id}/members/${member.user.id}`)).status).toBe(409); // no taker chosen
  expect((await admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${viewer.id}`)).status).toBe(409); // a Viewer cannot take it
  expect((await getTask(admin, t)).assignee.id).toBe(member.user.id);
  expect((await admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`)).status).toBe(204);
  expect((await getTask(admin, t)).assignee.id).toBe(admin.user.id);
  expect((await member.api.get(`/api/projects/${p.id}`)).status).toBe(404);
});

test("AC3: the removal dialog offers people to take the tasks and no 'leave unassigned' choice (screen)", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.4 dialog", members: [{ who: member, role: "EDITOR" }] });
  await admin.page.goto(`/projects/${p.id}/members`);
  await admin.page.locator(".item", { hasText: String(member.user.name) }).getByRole("button", { name: "Remove" }).first().click();
  const dlg = admin.page.getByRole("dialog");
  await expect(dlg.getByText("Who takes their tasks?")).toBeVisible();
  await expect(dlg.getByText(/unassigned/i)).toHaveCount(0);
});

test("AC4: the Leader cannot be removed or have their role changed here; the message points to Change Leader", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.4 leader", members: [{ who: member }] });
  const del = await admin.api.del(`/api/projects/${p.id}/members/${admin.user.id}`);
  expect(del.status).toBe(409);
  expect(del.json.error).toContain("Change Leader");
  const patch = await admin.api.patch(`/api/projects/${p.id}/members/${admin.user.id}`, { role: "VIEWER" });
  expect(patch.status).toBe(409);
  expect(patch.json.error).toContain("Change Leader");
});

test("AC5: a role change to Viewer for a member with open tasks follows 3.3 AC5 (needs a taker)", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.4 role", members: [{ who: member, role: "EDITOR" }] });
  const t = await newTask(member, p.id, { dueDate: "2026-11-03" });
  expect((await admin.api.patch(`/api/projects/${p.id}/members/${member.user.id}`, { role: "VIEWER" })).status).toBe(409);
  expect((await admin.api.patch(`/api/projects/${p.id}/members/${member.user.id}`, { role: "VIEWER", handoverTo: admin.user.id })).status).toBe(200);
  expect((await getTask(admin, t)).assignee.id).toBe(admin.user.id);
});

test("AC1 + AC2 (Admin half): the Super Admin, who does not lead the project, can add and remove a member; an Editor Leader is not needed", async ({ admin, member, later }) => {
  // The Member leads; the Super Admin only holds the organisation role. createProject allows any active person as Leader (src/lib/projects.ts:16); GET /api/projects/:id exposes the Leader only via members.
  const p = await newProject(admin, later, { label: "3.4 admin not leader", leader: member });
  const g = await ghost(admin, later, "byadmin");
  const add = await admin.api.post(`/api/projects/${p.id}/members`, { userId: g.id });
  expect(add.status, JSON.stringify(add.json)).toBe(201);
  const d = (await admin.api.get(`/api/projects/${p.id}`)).json.project;
  expect((d.members as { userId: string; role: string }[]).find((m) => m.role === "LEADER")?.userId, "the Member is the Leader, not the Super Admin").toBe(member.user.id);
  expect((await admin.api.del(`/api/projects/${p.id}/members/${g.id}`)).status).toBe(204);
});
