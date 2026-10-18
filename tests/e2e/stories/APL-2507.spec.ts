// APL-2507 · SHO-US-7.2 Assignment, membership and role notices
// Acceptance criteria: AC1 assigned, AC2 own action, AC3 removed (grouped when 5 or more), AC4 role change, AC5 deactivation hand-over.
// Needs the optional plain Member account (SHO_MEMBER_EMAIL / SHO_MEMBER_PASS): every notice goes to a second person.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz, type Who } from "../support";

async function withMember(admin: Who, member: Who, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const p = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${p}/archive`));
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  return { id: p, name: zz(label) };
}
const mk = async (who: Who, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await who.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};
const texts = async (who: Who) => ((await who.api.get("/api/notifications?limit=200")).json.items as { text: string }[]).map((n) => n.text);

test("AC1: being assigned a task gives one notice naming the task and who assigned it", async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "assign-notice", later);
  const t = await mk(admin, p.id, zz("assign me"));
  expect((await admin.api.post(`/api/tasks/${t}/assign`, { assigneeId: member.user.id })).status).toBe(200);
  const hits = (await texts(member)).filter((x) => x.includes(`"${zz("assign me")}"`));
  expect(hits).toHaveLength(1);
  expect(hits[0]).toContain(`${admin.user.name} assigned you`);
});

test("AC2: assigning a task to myself creates no notice", async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "assign-self", later);
  await mk(member, p.id, zz("mine already"), { assigneeId: member.user.id });
  expect((await texts(member)).some((x) => x.includes(zz("mine already")))).toBe(false);
});

test("AC3: being removed from a task as collaborator or assignee gives a notice naming the task", async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "remove-notice", later);
  const c = await mk(admin, p.id, zz("collab out"));
  expect((await admin.api.post(`/api/tasks/${c}/collaborators`, { userId: member.user.id })).status).toBe(201);
  expect((await admin.api.del(`/api/tasks/${c}/collaborators/${member.user.id}`)).status).toBeLessThan(300);
  const a = await mk(admin, p.id, zz("assignee out"), { assigneeId: member.user.id });
  expect((await admin.api.post(`/api/tasks/${a}/assign`, { assigneeId: admin.user.id })).status).toBe(200);
  const mine = await texts(member);
  expect(mine.filter((x) => x.includes(`removed you from "${zz("collab out")}"`))).toHaveLength(1);
  expect(mine.filter((x) => x.includes(`"${zz("assignee out")}"`) && x.includes("took"))).toHaveLength(1);
});

test("AC3 (grouping): removing a person from a project with 6 of their tasks gives ONE notice, not six", async ({ admin, member, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("remove-many"), leaderId: admin.user.id });
  const p = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${p}/archive`));
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  for (let i = 0; i < 6; i++) await mk(admin, p, zz(`bulk ${i}`), { assigneeId: member.user.id });
  expect((await admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`)).status).toBeLessThan(300);
  const hits = (await texts(member)).filter((x) => x.includes(`removed you from "${zz("remove-many")}"`));
  expect(hits, "one notice for the whole event").toHaveLength(1);
  // Blank out every quoted name first: the project name carries the run id, which can contain a "6" on its own.
  // With 5 or more tasks the tail gives a count and does not list titles (feed.ts leftNote).
  expect(hits[0].replace(/"[^"]*"/g, '""'), "the tail carries the count").toMatch(/\b6 open tasks\b/);
});

test("AC4: a changed project role and a changed Admin status each give a notice naming the new role and who made the change", async ({ admin, member, later }) => {
  const p = await withMember(admin, member, "role-notice", later);
  expect((await admin.api.patch(`/api/projects/${p.id}/members/${member.user.id}`, { role: "VIEWER", handoverTo: admin.user.id })).status).toBe(200);
  expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "ADMIN" })).status).toBe(200);
  later(() => admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" })); // always put the Member back
  const mine = await texts(member);
  expect(mine.some((x) => x.includes(`${admin.user.name} changed your role in "${p.name}" to viewer`))).toBe(true);
  expect(mine.some((x) => x.includes(`${admin.user.name} changed your role to admin`))).toBe(true);
  // switch back now so the demotion notice is also checked
  expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" })).status).toBe(200);
  expect((await texts(member)).some((x) => x.includes(`${admin.user.name} changed your role to member`))).toBe(true);
});

test.skip("AC5: a leaver's tasks fall back to the Leader with one notice — needs a throw-away person to deactivate; deactivating the shared staging Member would lock out later runs. Covered in tests/feed.test.ts", async () => {});
