import { patchCurrent } from "../helpers/jim-http";
import { test } from "./qa";
// SHO-US-4.4 Flag a task as Blocked (Linear APL-2494).
// The Super Admin acts as the project Leader; the plain Member (SHO_MEMBER_*) is the Editor/Viewer who flags. Member tests skip without it.
import { expect, zz, type Api } from "../support";
import { getTask, newProject, newTask } from "../helpers/migration-2731";

const count = async (who: { api: Api }, text: string) =>
  ((await who.api.get("/api/notifications")).json.items as { text: string }[]).filter((n) => n.text.includes(text));

test("AC1: a blocked task stays in its Section and shows a Blocked badge on the list (API and screen)", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.4 badge" });
  const title = zz("4.4 stuck");
  const t = await newTask(admin, p.id, { title, sectionId: p.doing });
  const r = await patchCurrent(admin, t, { blocked: true, blockedReason: "Waiting on data" });
  expect(r.status).toBe(200);
  const got = await getTask(admin, t);
  expect(got.blocked).toBe(true);
  expect(got.sectionId).toBe(p.doing);
  await admin.page.goto(`/projects/${p.id}`);
  const row = admin.page.locator(".item", { hasText: title }).first();
  await expect(row.getByText("Blocked", { exact: true })).toBeVisible();
});

test("AC2: clearing the flag removes the badge and the reason", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.4 clear" });
  const title = zz("4.4 cleared");
  const t = await newTask(admin, p.id, { title });
  await patchCurrent(admin, t, { blocked: true, blockedReason: "Waiting" });
  const r = await patchCurrent(admin, t, { blocked: false });
  expect(r.status).toBe(200);
  const got = await getTask(admin, t);
  expect(got.blocked).toBe(false);
  expect(got.blockedReason).toBeNull();
  await admin.page.goto(`/projects/${p.id}`);
  const row = admin.page.locator(".item", { hasText: title }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText("Blocked", { exact: true })).toHaveCount(0);
});

test("AC2: ticking 'This task is blocked' in the task panel sets and clears it (screen)", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.4 panel" });
  const t = await newTask(admin, p.id);
  await admin.page.goto(`/projects/${p.id}?task=${t}`);
  const box = admin.page.getByRole("dialog").getByLabel("This task is blocked");
  await box.click();
  await expect.poll(async () => (await getTask(admin, t)).blocked).toBe(true);
  await expect(admin.page.getByRole("dialog").getByLabel("Why is it blocked?")).toBeVisible();
  await expect(box).toBeChecked();
  await box.click();
  await expect.poll(async () => (await getTask(admin, t)).blocked).toBe(false);
});

test("AC3: a Viewer cannot set or clear the flag, and nobody can in an archived project", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.4 viewer", members: [{ who: member, role: "VIEWER" }] });
  const t = await newTask(admin, p.id);
  expect((await patchCurrent(member, t, { blocked: true })).status).toBe(403);
  await patchCurrent(admin, t, { blocked: true, blockedReason: "x" });
  expect((await patchCurrent(member, t, { blocked: false })).status).toBe(403);
  await admin.api.post(`/api/projects/${p.id}/archive`);
  expect((await patchCurrent(admin, t, { blocked: false })).status).toBe(409);
});

test("AC4: the Leader gets one notice naming the task, who flagged and why; none when the Leader flags or when cleared", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.4 notice", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("4.4 notice task");
  const t = await newTask(member, p.id, { title });
  expect(await count(admin, title)).toHaveLength(0);
  expect((await patchCurrent(member, t, { blocked: true, blockedReason: "Need the budget" })).status).toBe(200);
  const first = await count(admin, title);
  expect(first).toHaveLength(1);
  expect(first[0].text).toContain(String(member.user.name));
  expect(first[0].text).toContain("Need the budget");
  // Editing the reason while blocked sends nothing new; clearing sends nothing.
  await patchCurrent(member, t, { blockedReason: "Need the budget by Friday" });
  await patchCurrent(member, t, { blocked: false });
  expect(await count(admin, title)).toHaveLength(1);
  // Setting it again after clearing sends a new one.
  await patchCurrent(member, t, { blocked: true, blockedReason: "Again" });
  expect(await count(admin, title)).toHaveLength(2);
  // The Leader flagging their own task sends no notice to the Leader.
  const own = zz("4.4 leader flags");
  const lt = await newTask(admin, p.id, { title: own });
  await patchCurrent(admin, lt, { blocked: true, blockedReason: "mine" });
  expect(await count(admin, own)).toHaveLength(0);
});
