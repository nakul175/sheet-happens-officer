// SHO-BUG-7 Removing a member through the concierge sends one notice per task instead of the screen's single handover notice  (Linear APL-2614)
// No numbered ACs in the issue; follows its "Expected" and "Test" paragraphs.
import { test, expect, zz, RUN } from "../support";
import { newProject, newTask } from "../g2";
import { cleanChat } from "../helpers/jim-http";
import { ask, cardOf, requireModel, showConcierge, taskOf } from "../helpers/jim-concierge";

test("Reference (screen path): removing a member who holds 3 tasks sends the leaver no per-task notices and logs the removal once", async ({ admin, member, later }) => {
  const pr = await admin.api.post("/api/projects", { name: zz("handover"), leaderId: admin.user.id });
  expect(pr.status).toBe(201);
  const pid = pr.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  for (const n of ["one", "two", "three"]) {
    expect((await admin.api.post(`/api/projects/${pid}/tasks`, { title: zz(`held ${n}`), assigneeId: member.user.id })).status).toBe(201);
  }
  expect((await admin.api.del(`/api/projects/${pid}/members/${member.user.id}?handoverTo=${admin.user.id}`)).status).toBe(204);
  const after = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  const mine = after.filter((n) => /took "ZZ-TEST[^"]* held/.test(n.text) && n.text.includes(RUN));
  expect(mine, "no 'took <task> off you' notice per task").toHaveLength(0);
  expect(after.filter((n) => /removed you from/.test(n.text) && n.text.includes(zz("handover"))), "exactly one removal notice").toHaveLength(1);
  const act = (await admin.api.get(`/api/projects/${pid}/activity`)).json.items as { what: string; kind: string }[];
  // SHO-2701: both counts are on the kind. The one removal is still asserted to read as a removal.
  const removals = act.filter((a) => a.kind === "member.removed");
  expect(removals).toHaveLength(1);
  expect(removals[0].what).toMatch(/^removed /);
  expect(act.filter((a) => a.kind === "task.assigned"), "no per-task reassignment rows on the screen path").toHaveLength(0);
});

test("Concierge path: a confirmed 'remove member' card writes the same notices and log row as the screen", async ({ admin, member, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  await showConcierge(admin, later);
  const project = await newProject(admin, later, { label: "handover-chat", members: [{ who: member, role: "EDITOR" }] });
  const ids = [];
  for (const label of ["one", "two", "three"]) ids.push(await newTask(admin, project.id, { title: zz(`held ${label}`), assigneeId: member.user.id }));
  const before = (await member.api.get("/api/notifications")).json.items as { id: string }[];
  const beforeIds = new Set(before.map((n) => n.id));
  const asked = await ask(admin, `Remove the person with email ${member.user.email} from ${project.name}.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.irreversible).toBe(true);
  expect(card?.handover?.map((h) => h.taskId).sort()).toEqual([...ids].sort());
  await admin.page.goto(`/projects/${project.id}`);
  const dock = admin.page.locator("aside.cc-slot");
  await expect(dock.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  const receivers = dock.locator(".cc-ho select");
  await expect(receivers).toHaveCount(3);
  for (const receiver of await receivers.all()) await receiver.selectOption(admin.user.id);
  await dock.locator(".cc-warn input").check();
  await dock.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dock.locator(".cc-result")).toContainText(/can't be undone/i);
  for (const id of ids) expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
  const after = (await member.api.get("/api/notifications")).json.items as { id: string; text: string }[];
  const fresh = after.filter((n) => !beforeIds.has(n.id));
  expect(fresh.filter((n) => n.text.includes(project.name) && /removed you from/.test(n.text))).toHaveLength(1);
  expect(fresh.filter((n) => /took.*off you/.test(n.text) && n.text.includes(RUN))).toHaveLength(0);
  const activity = (await admin.api.get(`/api/projects/${project.id}/activity`)).json.items as { kind: string }[];
  expect(activity.filter((a) => a.kind === "member.removed")).toHaveLength(1);
  expect(activity.filter((a) => a.kind === "task.assigned")).toHaveLength(0);
});
