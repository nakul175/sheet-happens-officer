// SHO-US-2.3 Deactivate and reactivate people (APL-2482). Acceptance criteria AC1 to AC3.
// People added from the Team page get an emailed password nobody can read here, so the "cannot sign in" and "signs in again" halves
// are manual. Everything else is checked on throw-away "ZZ-TEST" people.
import { test, expect, RUN, zz, type Api, type Json } from "../support";

type Ctx = { api: Api; user: Json };
async function person(admin: Ctx, later: (f: () => Promise<unknown>) => void, label: string, role: "MEMBER" | "ADMIN" = "MEMBER") {
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email: `zz-test-${RUN}-${label}@example.invalid`, role });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(async () => { const s = (await admin.api.get(`/api/team/${id}`)).json.person?.status; if (s !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
  return { id, name: `ZZ-TEST ${label} ${RUN}` };
}
async function project(admin: Ctx, later: (f: () => Promise<unknown>) => void, label: string) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return id;
}
const statusOf = async (admin: Ctx, id: string) => (await admin.api.get(`/api/team/${id}`)).json.person.status as string;

test.describe("SHO-US-2.3 / APL-2482", () => {
  test("AC1: an Admin deactivates a Member: they are kept (never deleted), cannot be given new tasks, and their open tasks are handed over", async ({ admin, later }) => {
    const p = await person(admin, later, "leaver");
    const proj = await project(admin, later, "2.3 ac1");
    expect((await admin.api.post(`/api/projects/${proj}/members`, { userId: p.id, role: "EDITOR" })).status).toBe(201);
    const t = await admin.api.post(`/api/projects/${proj}/tasks`, { title: zz("leaver task"), assigneeId: p.id });
    expect(t.status).toBe(201);
    const taskId = t.json.task.id as string;

    const d = await admin.api.post(`/api/team/${p.id}/deactivate`, { reassign: "leaders" });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json.moved).toBeGreaterThanOrEqual(1);
    expect(await statusOf(admin, p.id)).toBe("DEACTIVATED"); // history kept: the person is still there
    const row = (await admin.api.get("/api/team")).json.people.find((x: Json) => x.id === p.id);
    expect(row?.status).toBe("DEACTIVATED");

    // They cannot be assigned new tasks.
    const assign = await admin.api.post(`/api/tasks/${taskId}/assign`, { assigneeId: p.id });
    expect(assign.status).toBeGreaterThanOrEqual(400);
    // Prohibited: any hard delete.
    expect([404, 405]).toContain((await admin.api.del(`/api/team/${p.id}`)).status);
  });

  test.skip("AC1 (sessions and sign-in): their sessions end and they cannot sign in", async () => {
    // Needs the person's password, which is only ever emailed. Run by hand with a real test mailbox.
  });

  test("AC2: only the Super Admin can act on Admins; a Member cannot act on anyone; nobody can deactivate a Super Admin", async ({ admin, member, later }) => {
    const adminPerson = await person(admin, later, "adminrole", "ADMIN");
    const plain = await person(admin, later, "plainrole");
    // A Member may not deactivate an Admin or a Member.
    expect((await member.api.post(`/api/team/${adminPerson.id}/deactivate`, { reassign: "leaders" })).status).toBe(403);
    expect((await member.api.post(`/api/team/${plain.id}/deactivate`, { reassign: "leaders" })).status).toBe(403);
    expect(await statusOf(admin, adminPerson.id)).toBe("ACTIVE");
    // Nobody deactivates the Super Admin in the app.
    expect((await member.api.post(`/api/team/${admin.user.id}/deactivate`, { reassign: "leaders" })).status).toBe(403);
    expect([403, 409]).toContain((await admin.api.post(`/api/team/${admin.user.id}/deactivate`, { reassign: "leaders" })).status);
    expect((await admin.api.get("/api/auth/me")).json.user.orgRole).toBe("SUPER_ADMIN");
    // The Super Admin can act on an Admin, and a Member cannot undo it.
    expect((await admin.api.post(`/api/team/${adminPerson.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    expect((await member.api.post(`/api/team/${adminPerson.id}/reactivate`)).status).toBe(403);
    expect(await statusOf(admin, adminPerson.id)).toBe("DEACTIVATED");
  });

  test("AC2 (Admin acting on an Admin): an Admin who is not the Super Admin is refused, for deactivating and for reactivating", async ({ admin, member, later }) => {
    // The plain Member is made an Admin for the length of this test only. The role is put back in the finally block and again by `later`.
    later(() => admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" }));
    const target = await person(admin, later, "adminfoe", "ADMIN");
    expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "ADMIN" })).status).toBe(200);
    try {
      expect((await member.api.post(`/api/team/${target.id}/deactivate`, { reassign: "leaders" })).status, "an Admin may not deactivate an Admin").toBe(403);
      expect(await statusOf(admin, target.id)).toBe("ACTIVE");
      expect((await admin.api.post(`/api/team/${target.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
      expect((await member.api.post(`/api/team/${target.id}/reactivate`)).status, "an Admin may not reactivate an Admin").toBe(403);
      expect(await statusOf(admin, target.id)).toBe("DEACTIVATED");
    } finally {
      await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" });
    }
  });

  test("AC3: reactivating restores the person and their old project membership, but does not hand reassigned tasks back", async ({ admin, later }) => {
    const p = await person(admin, later, "returner");
    const proj = await project(admin, later, "2.3 ac3");
    await admin.api.post(`/api/projects/${proj}/members`, { userId: p.id, role: "EDITOR" });
    const t = await admin.api.post(`/api/projects/${proj}/tasks`, { title: zz("returner task"), assigneeId: p.id });
    const taskId = t.json.task.id as string;
    expect((await admin.api.post(`/api/team/${p.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);

    const re = await admin.api.post(`/api/team/${p.id}/reactivate`);
    expect(re.status).toBe(200);
    expect(await statusOf(admin, p.id)).toBe("ACTIVE");
    const members = (await admin.api.get(`/api/projects/${proj}`)).json.project.members as { userId: string; role: string }[];
    expect(members.find((m) => m.userId === p.id)?.role, "membership as it was").toBe("EDITOR");
    const task = (await admin.api.get(`/api/tasks/${taskId}`)).json.task;
    expect(task.assignee.id, "the task stays with the person it was handed to").toBe(admin.user.id);
    // Reactivating someone who is already active is refused.
    expect((await admin.api.post(`/api/team/${p.id}/reactivate`)).status).toBe(409);
  });

  test.skip("AC3 (sign-in): the reactivated person can sign in again", async () => {
    // Needs the person's password, which is only ever emailed.
  });
});
