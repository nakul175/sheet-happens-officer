// SHO-US-4.2 Edit task details (Linear APL-2492).
// The Super Admin acts as Leader; the plain Member (SHO_MEMBER_*) is the other Editor / the Viewer. Member tests skip without it.
import { test, expect, zz } from "../support";
import { getTask, newProject, newTask, ymd } from "../g2";

test("AC1: an Editor changes the due date; it shows on the task and is logged with its before-state", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.2 date", members: [{ who: member, role: "EDITOR" }] });
  const t = await newTask(member, p.id);
  expect((await member.api.patch(`/api/tasks/${t}`, { dueDate: ymd(5) })).status).toBe(200);
  expect((await getTask(admin, t)).dueDate).toBe(ymd(5));
  const items = (await admin.api.get(`/api/projects/${p.id}/activity`)).json.items as { what: string; kind: string; undo: string }[];
  // SHO-2701: the edit is the row of kind task.updated. Which field it changed is not part of the kind, so the
  // sentence is still read for that - but the row is no longer selected by its wording.
  const row = items.find((i) => i.kind === "task.updated");
  expect(row, "an activity row of kind task.updated").toBeTruthy();
  expect(row!.what, "an activity row 'changed due date from no date to ...'").toMatch(/changed due date from no date to/);
  expect(row!.undo).toBe("available"); // the before-state is kept, so it can be undone
  expect((await member.api.patch(`/api/tasks/${t}`, { priority: "HIGH", description: "ZZ-TEST detail" })).status).toBe(200);
});

test("AC2: an empty title is refused with 'Give the task a title.' (API and screen)", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.2 title" });
  const t = await newTask(admin, p.id);
  const r = await admin.api.patch(`/api/tasks/${t}`, { title: "   " });
  expect(r.status).toBe(400);
  expect(JSON.stringify(r.json)).toContain("Give the task a title.");
  const before = (await getTask(admin, t)).title;
  await admin.page.goto(`/projects/${p.id}?task=${t}`);
  const title = admin.page.getByLabel("Title", { exact: true });
  await expect(title).toHaveValue(before);
  await title.fill("");
  await title.press("Enter");
  await expect(admin.page.getByRole("alert").filter({ hasText: "Give the task a title." })).toBeVisible();
  expect((await getTask(admin, t)).title).toBe(before);
});

test("AC3: a Viewer sees every field read-only and the API refuses; an archived project is read-only for everyone", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.2 viewer", members: [{ who: member, role: "VIEWER" }] });
  const t = await newTask(admin, p.id);
  expect((await member.api.patch(`/api/tasks/${t}`, { title: zz("x") })).status).toBe(403);
  await member.page.goto(`/projects/${p.id}?task=${t}`);
  await expect(member.page.getByLabel("Title", { exact: true })).toHaveAttribute("readonly", "");
  await expect(member.page.getByRole("dialog").getByLabel("Due date")).toHaveCount(0); // a plain date instead of the date input
  await expect(member.page.getByRole("dialog").getByLabel("Priority")).toHaveCount(0);
  await expect(member.page.locator("#desc")).toHaveAttribute("readonly", "");
  await admin.api.post(`/api/projects/${p.id}/archive`);
  expect((await admin.api.patch(`/api/tasks/${t}`, { title: zz("y") })).status).toBe(409);
  await admin.page.goto(`/projects/${p.id}?task=${t}`);
  await expect(admin.page.getByLabel("Title", { exact: true })).toHaveAttribute("readonly", "");
  await expect(admin.page.getByText("This project is archived and read-only.").first()).toBeVisible();
});

test("AC4: a save on a task someone else changed is refused, names them, shows current values (API)", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.2 stale api", members: [{ who: member, role: "EDITOR" }] });
  const t = await newTask(admin, p.id);
  const seen = (await getTask(member, t)).updatedAt;
  expect((await admin.api.patch(`/api/tasks/${t}`, { dueDate: ymd(3) })).status).toBe(200);
  const r = await member.api.patch(`/api/tasks/${t}`, { title: zz("mine"), expectedUpdatedAt: seen });
  expect(r.status).toBe(409);
  expect(r.json.stale).toBe(true);
  expect(r.json.changedBy).toBe(admin.user.name);
  expect(r.json.current.dueDate).toBe(ymd(3));
  const fresh = (await getTask(member, t)).updatedAt;
  expect((await member.api.patch(`/api/tasks/${t}`, { title: zz("mine"), expectedUpdatedAt: fresh })).status).toBe(200);
});

test("AC4: on the screen the stale warning keeps my edit and 'Re-apply my edit' saves it", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.2 stale ui", members: [{ who: member, role: "EDITOR" }] });
  const t = await newTask(admin, p.id);
  await admin.page.goto(`/projects/${p.id}?task=${t}`);
  const title = admin.page.getByLabel("Title", { exact: true });
  await expect(title).toBeVisible();
  // Someone else saves after I opened the task.
  expect((await member.api.patch(`/api/tasks/${t}`, { dueDate: ymd(4) })).status).toBe(200);
  const mine = zz("4.2 my edit");
  await title.fill(mine);
  await title.press("Enter");
  const warn = admin.page.getByRole("alert").filter({ hasText: "changed this task while you were editing" });
  await expect(warn).toBeVisible();
  await expect(warn).toContainText(String(member.user.name));
  await expect(warn).toContainText(mine); // my unsaved edit stays visible
  expect((await getTask(admin, t)).title).not.toBe(mine); // and was not silently saved
  await warn.getByRole("button", { name: "Re-apply my edit" }).click();
  await expect.poll(async () => (await getTask(admin, t)).title).toBe(mine);
});
