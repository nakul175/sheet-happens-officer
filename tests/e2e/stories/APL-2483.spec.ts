// SHO-US-2.4 Reassign a leaver's tasks when deactivating (APL-2483). Acceptance criteria AC1 to AC6.
import { test, expect, RUN, zz, type Api, type Json } from "../support";

type Ctx = { api: Api; user: Json };
type Later = (f: () => Promise<unknown>) => void;
async function person(admin: Ctx, later: Later, label: string) {
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email: `zz-test-${RUN}-${label}@example.invalid`, role: "MEMBER" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(async () => { const s = (await admin.api.get(`/api/team/${id}`)).json.person?.status; if (s !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
  return { id, name: `ZZ-TEST ${label} ${RUN}` };
}
async function project(admin: Ctx, later: Later, label: string, leaderId?: string) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: leaderId ?? admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name: zz(label) };
}
const add = async (admin: Ctx, proj: string, userId: string, role: "EDITOR" | "VIEWER") => expect((await admin.api.post(`/api/projects/${proj}/members`, { userId, role })).status).toBe(201);
const task = async (admin: Ctx, proj: string, assigneeId: string, extra: Json = {}) => {
  const r = await admin.api.post(`/api/projects/${proj}/tasks`, { title: zz("task"), assigneeId, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};
const assignee = async (admin: Ctx, id: string) => (await admin.api.get(`/api/tasks/${id}`)).json.task.assignee?.id as string;

test.describe("SHO-US-2.4 / APL-2483", () => {
  test("AC1: naming a Leader or Editor of the task's project gives them the leaver's task", async ({ admin, later }) => {
    const leaver = await person(admin, later, "leaver1");
    const taker = await person(admin, later, "taker1");
    const p = await project(admin, later, "2.4 ac1");
    await add(admin, p.id, leaver.id, "EDITOR");
    await add(admin, p.id, taker.id, "EDITOR");
    const t = await task(admin, p.id, leaver.id, { dueDate: "2026-11-03" });
    const r = await admin.api.post(`/api/team/${leaver.id}/deactivate`, { reassign: taker.id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.fellBack).toEqual([]);
    expect(await assignee(admin, t)).toBe(taker.id);
  });

  test("AC2: naming someone who is not an Editor or Leader of a project (a Viewer, or a non-member) sends that project's tasks to its Leader, and the summary lists the project", async ({ admin, later }) => {
    const leaver = await person(admin, later, "leaver2");
    const viewer = await person(admin, later, "viewer2");
    const outsider = await person(admin, later, "outsider2");
    const p = await project(admin, later, "2.4 ac2 a");
    const q = await project(admin, later, "2.4 ac2 b");
    await add(admin, p.id, leaver.id, "EDITOR");
    await add(admin, p.id, viewer.id, "VIEWER");
    await add(admin, q.id, leaver.id, "EDITOR");
    const tp = await task(admin, p.id, leaver.id, { dueDate: "2026-11-03" });
    const tq = await task(admin, q.id, leaver.id, { dueDate: "2026-11-03" });

    const r = await admin.api.post(`/api/team/${leaver.id}/deactivate`, { reassign: viewer.id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect([...r.json.fellBack].sort()).toEqual([p.name, q.name].sort());
    expect(await assignee(admin, tp)).toBe(admin.user.id);
    expect(await assignee(admin, tq)).toBe(admin.user.id);
    // Prohibited: giving a task to anyone without access to its project.
    const direct = await admin.api.post(`/api/tasks/${tp}/assign`, { assigneeId: outsider.id });
    expect(direct.status).toBeGreaterThanOrEqual(400);
  });

  test("AC2 (screen): the Team page shows the summary of tasks moved after a deactivation", async ({ admin, later }) => {
    test.setTimeout(240_000);
    const leaver = await person(admin, later, "leaver2ui");
    const p = await project(admin, later, "2.4 ac2 ui");
    await add(admin, p.id, leaver.id, "EDITOR");
    await task(admin, p.id, leaver.id, { dueDate: "2026-11-03" });
    await admin.page.goto("/team");
    const row = admin.page.locator("tr", { hasText: leaver.name });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole("button", { name: "Deactivate" }).click({ timeout: 60_000 });
    const dialog = admin.page.getByRole("dialog");
    await expect(dialog).toContainText(`Deactivate ${leaver.name}?`, { timeout: 30_000 });
    await expect(dialog.getByLabel("Who takes their open tasks?")).toBeVisible();
    await dialog.getByRole("button", { name: "Deactivate", exact: true }).click();
    const done = admin.page.getByRole("dialog");
    await expect(done).toContainText(`${leaver.name} is deactivated`, { timeout: 120_000 });
    await expect(done).toContainText("1 open task was handed over.");
  });

  test("AC3: 'each project's Leader' sends every open task to the Leader of its own project", async ({ admin, later }) => {
    const leaver = await person(admin, later, "leaver3");
    const p = await project(admin, later, "2.4 ac3 a");
    const q = await project(admin, later, "2.4 ac3 b");
    await add(admin, p.id, leaver.id, "EDITOR");
    await add(admin, q.id, leaver.id, "EDITOR");
    const tp = await task(admin, p.id, leaver.id, { dueDate: "2026-11-03" });
    const tq = await task(admin, q.id, leaver.id, { dueDate: "2026-11-03" });
    const r = await admin.api.post(`/api/team/${leaver.id}/deactivate`, { reassign: "leaders" });
    expect(r.status).toBe(200);
    expect(r.json.moved).toBeGreaterThanOrEqual(2);
    expect(await assignee(admin, tp)).toBe(admin.user.id);
    expect(await assignee(admin, tq)).toBe(admin.user.id);
  });

  test("AC4: a person who leads a project cannot be deactivated until a new Leader is named, and the person stays active", async ({ admin, later }) => {
    const lead = await person(admin, later, "leader4");
    const p = await project(admin, later, "2.4 ac4", lead.id);
    // Hand the project back before clean-up so the person can be deactivated at the end.
    later(async () => { await admin.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: admin.user.id, previousRole: "REMOVE" }); });
    const r = await admin.api.post(`/api/team/${lead.id}/deactivate`, { reassign: "leaders" });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("Name a new Leader first for:");
    expect(r.json.error).toContain(p.name);
    expect((r.json.leads as { id: string }[]).map((l) => l.id)).toContain(p.id);
    expect((await admin.api.get(`/api/team/${lead.id}`)).json.person.status).toBe("ACTIVE");
    // Once the Leader is changed, it goes through.
    expect((await admin.api.post(`/api/projects/${p.id}/leader`, { newLeaderId: admin.user.id, previousRole: "REMOVE" })).status).toBe(200);
    expect((await admin.api.post(`/api/team/${lead.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
  });

  // AC5 includes the acting Leader: deactivation must send one counted handover notice.
  test("AC5: the person who receives tasks and the Leader are told", async ({ admin, later }) => {
    const leaver = await person(admin, later, "leaver5");
    const p = await project(admin, later, "2.4 ac5");
    await add(admin, p.id, leaver.id, "EDITOR");
    await task(admin, p.id, leaver.id, { dueDate: "2026-11-03" });
    expect((await admin.api.post(`/api/team/${leaver.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    const after = await admin.api.get("/api/notifications?limit=50");
    const notes = after.json.items as { text: string; href: string }[];
    const handover = notes.filter((n) => n.href === `/projects/${p.id}` && /handed over/.test(n.text));
    expect(handover).toHaveLength(1);
    expect(handover[0].text).toContain("1 open task is now yours");
  });

  test("AC5 (receiver): the named person who receives a task is told", async ({ admin, member, later }) => {
    const leaver = await person(admin, later, "leaver5r");
    const p = await project(admin, later, "2.4 ac5 receiver");
    await add(admin, p.id, leaver.id, "EDITOR");
    await add(admin, p.id, member.user.id, "EDITOR");
    later(() => admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`));
    const title = zz("handed over");
    await task(admin, p.id, leaver.id, { dueDate: "2026-11-03", title });
    const read = async () => (await member.api.get("/api/notifications?limit=200")).json as { unread: number; items: { id: string; text: string }[] };
    const before = await read();
    expect((await admin.api.post(`/api/team/${leaver.id}/deactivate`, { reassign: member.user.id })).status).toBe(200);
    const after = await read();
    expect(after.unread, "the receiver has a new unread notice").toBeGreaterThan(before.unread);
    // Only notices that arrived after the deactivation. The handover notice is generic (src/lib/feed.ts:30/46/62)
    // and names neither the project nor the task, so match its wording, not the earlier "added you to" notice.
    const seen = new Set(before.items.map((n) => n.id));
    const fresh = after.items.filter((n) => !seen.has(n.id));
    expect(fresh.some((n) => /handed over/i.test(n.text) && /open task/i.test(n.text)), JSON.stringify(fresh.map((n) => n.text))).toBe(true);
  });

  test("AC6: a subtask assigned to the leaver is reassigned by the same rules as a task", async ({ admin, later }) => {
    const leaver = await person(admin, later, "leaver6");
    const taker = await person(admin, later, "taker6");
    const p = await project(admin, later, "2.4 ac6");
    await add(admin, p.id, leaver.id, "EDITOR");
    await add(admin, p.id, taker.id, "EDITOR");
    const parent = await task(admin, p.id, admin.user.id, { dueDate: "2026-11-03" });
    const sub = await task(admin, p.id, leaver.id, { parentId: parent });
    expect((await admin.api.post(`/api/team/${leaver.id}/deactivate`, { reassign: taker.id })).status).toBe(200);
    expect(await assignee(admin, sub)).toBe(taker.id);
    expect(await assignee(admin, parent), "the parent was not the leaver's").toBe(admin.user.id);
  });
});
