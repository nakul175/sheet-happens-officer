// SHO-US-14.16 Approvals view (APL-2575). Needs the optional Member account: the Member sends, the Super Admin approves.
import { test, expect, zz, type Who, type Later } from "../support";

async function held(admin: Who, member: Who, later: Later, label: string) {
  const r = await admin.api.post("/api/projects", { name: zz("approvals"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz(label);
  const t = (await admin.api.post(`/api/projects/${id}/tasks`, { title, assigneeId: member.user.id, approverId: admin.user.id })).json.task.id as string;
  expect((await member.api.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
  return { id, t, title };
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("AC1: tasks awaiting my approval sit in a group at the top of My tasks with their age in days", async ({ admin, member, later }) => {
  const { t, title } = await held(admin, member, later, "waiting");
  const p = admin.page;
  await p.goto("/");
  const group = p.getByRole("region", { name: "Waiting on me" });
  await expect(group).toBeVisible();
  await expect(group.getByText(title)).toBeVisible();
  await expect(group.getByText("Waiting since today").first()).toBeVisible();
  // at the top of the task groups (the first-run Start guide card, when shown, sits above all groups)
  const labels = await p.locator("main.content").last().locator("section[aria-label]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")).filter((l) => l !== "Start guide"));
  expect(labels[0]).toBe("Waiting on me");
  expect((await admin.api.get("/api/my-tasks")).json.waitingOnMe.map((x: { id: string }) => x.id)).toContain(t);
});

test("AC2: Close in the row closes the task in one step and offers Undo", async ({ admin, member, later }) => {
  const { t, title } = await held(admin, member, later, "close");
  const p = admin.page;
  await p.goto("/");
  await p.getByRole("button", { name: `Close "${title}"` }).click();
  await expect(p.getByRole("button", { name: `Close "${title}"` })).toHaveCount(0);
  expect((await admin.api.get(`/api/tasks/${t}`)).json.task.completedAt).toBeTruthy();
  await expect(p.getByRole("button", { name: /^Undo/ }).first()).toBeVisible();
});

test("AC3: with nothing waiting, the group is absent", async ({ admin, member, later }) => {
  const { id, t, title } = await held(admin, member, later, "gone");
  expect((await admin.api.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
  const rest = (await admin.api.get("/api/my-tasks")).json.waitingOnMe as unknown[];
  test.skip(rest.length > 0, "Other tasks are already waiting on this account, so the group is legitimately present.");
  await admin.page.goto("/");
  await expect(admin.page.getByRole("region", { name: "Waiting on me" })).toHaveCount(0);
  await expect(admin.page.getByText(title)).toHaveCount(0);
  void id;
});

test("AC4: a task I sent for approval appears under 'Waiting on others' and not under mine", async ({ admin, member, later }) => {
  const { t, title } = await held(admin, member, later, "others");
  const mine = (await member.api.get("/api/my-tasks")).json;
  expect(ids(mine.waitingOnOthers)).toContain(t);
  expect([...mine.overdue, ...mine.next7, ...mine.later, ...(mine.waitingOnMe ?? [])].some((x: { id: string }) => x.id === t)).toBe(false);
  const p = member.page;
  await p.goto("/");
  await expect(p.getByRole("region", { name: "Waiting on others" }).getByText(title)).toBeVisible();
  await expect(p.getByRole("region", { name: "Waiting on me" }).getByText(title)).toHaveCount(0);
});
