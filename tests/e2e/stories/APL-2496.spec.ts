// APL-2496 · SHO-US-5.1 My tasks as the home page
// Acceptance criteria: AC1 two projects grouped by date, AC2 collaborator tag and tick, AC3 access, AC4 empty state.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz, hasMember } from "../support";

const ist = (d: number) => new Date(Date.now() + 5.5 * 3600e3 + d * 864e5).toISOString().slice(0, 10);

async function proj(admin: any, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return id;
}
const ids = (list: { id: string }[]) => list.map((t) => t.id);

test("AC1: tasks assigned to me in two projects appear in the right date group with the project named", async ({ admin, later }) => {
  const p1 = await proj(admin, "mt-a", later);
  const p2 = await proj(admin, "mt-b", later);
  const over = (await admin.api.post(`/api/projects/${p1}/tasks`, { title: zz("overdue"), assigneeId: admin.user.id, dueDate: ist(-2) })).json.task.id;
  const soon = (await admin.api.post(`/api/projects/${p2}/tasks`, { title: zz("soon"), assigneeId: admin.user.id, dueDate: ist(3) })).json.task.id;
  const far = (await admin.api.post(`/api/projects/${p2}/tasks`, { title: zz("later"), assigneeId: admin.user.id, dueDate: ist(30) })).json.task.id;
  const nodate = (await admin.api.post(`/api/projects/${p2}/tasks`, { title: zz("nodate"), assigneeId: admin.user.id })).json.task.id;
  const mine = (await admin.api.get("/api/my-tasks")).json;
  expect(ids(mine.overdue)).toContain(over);
  expect(ids(mine.next7)).toContain(soon);
  expect(ids(mine.later)).toEqual(expect.arrayContaining([far, nodate]));
  expect(mine.overdue.find((t: any) => t.id === over).project.name).toBe(zz("mt-a"));
  // undated tasks sit last in Later
  const later_ = ids(mine.later);
  expect(later_.indexOf(nodate)).toBeGreaterThan(later_.indexOf(far));
  // On screen: the three headings and the rows with their project name.
  await admin.page.goto("/");
  const group = (name: string) => admin.page.locator(`section[aria-label="${name}"]`).first();
  await expect(group("Overdue").locator(".item", { hasText: zz("overdue") })).toContainText(zz("mt-a"));
  await expect(group("Next 7 days").locator(".item", { hasText: zz("soon") })).toContainText(zz("mt-b"));
  await expect(group("Later").locator(".item", { hasText: zz("later") })).toBeVisible();
});

test("AC2: a collaborator task shows a Collaborator tag, and a Viewer gets no tick", async ({ admin, member, later }) => {
  const p = await proj(admin, "mt-collab", later);
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = (await admin.api.post(`/api/projects/${p}/tasks`, { title: zz("collab"), collaboratorIds: [member.user.id], dueDate: ist(1) })).json.task.id;
  let mine = (await member.api.get("/api/my-tasks")).json;
  const row = mine.next7.find((x: any) => x.id === t);
  expect(row, "collaborator sees the task").toBeTruthy();
  expect(row.relation).toBe("COLLABORATOR");
  expect(row.canClose).toBe(true); // Editor
  await member.page.goto("/");
  const ui = member.page.locator(".item", { hasText: zz("collab") }).first();
  await expect(ui).toContainText("Collaborator");
  // Change the person to Viewer: no tick.
  expect((await admin.api.patch(`/api/projects/${p}/members/${member.user.id}`, { role: "VIEWER" })).status).toBe(200);
  mine = (await member.api.get("/api/my-tasks")).json;
  expect(mine.next7.find((x: any) => x.id === t).canClose).toBe(false);
});

test("AC3: a task in a project I was removed from, or an archived project, no longer appears", async ({ admin, member, later }) => {
  const p = await proj(admin, "mt-access", later);
  const q = await proj(admin, "mt-archived", later);
  for (const id of [p, q]) expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const inP = (await admin.api.post(`/api/projects/${p}/tasks`, { title: zz("removed"), assigneeId: member.user.id })).json.task.id;
  const inQ = (await admin.api.post(`/api/projects/${q}/tasks`, { title: zz("archived"), assigneeId: member.user.id })).json.task.id;
  const all = async () => { const m = (await member.api.get("/api/my-tasks")).json; return ids([...m.overdue, ...m.next7, ...m.later]); };
  expect(await all()).toEqual(expect.arrayContaining([inP, inQ]));
  expect((await admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`)).status).toBe(204);
  expect((await admin.api.post(`/api/projects/${q}/archive`)).status).toBe(200);
  later(() => admin.api.del(`/api/projects/${q}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const after = await all();
  expect(after).not.toContain(inP);
  expect(after).not.toContain(inQ);
});

test("AC4: with no assigned tasks a clear empty state shows", async ({ admin }) => {
  // A live account may hold tasks, so the empty list is served to the page by intercepting the one request.
  await admin.page.route("**/api/my-tasks*", (route) => route.fulfill({ json: { waitingOnMe: [], waitingOnOthers: [], overdue: [], next7: [], later: [], needsNextStep: [] } }));
  await admin.page.goto("/");
  await expect(admin.page.getByText("Nothing on your plate.")).toBeVisible();
  await expect(admin.page.getByText("Tasks assigned to you, or that you collaborate on, show up here.")).toBeVisible();
});
