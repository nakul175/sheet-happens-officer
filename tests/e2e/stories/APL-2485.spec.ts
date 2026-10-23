// SHO-US-3.1 Create a project and name its Leader (Linear APL-2485).
// Runs against staging. Super Admin from SHO_ADMIN_*; the plain Member (SHO_MEMBER_*) is optional.
import { test, expect, zz, RUN } from "../support";
import { newProject } from "../g2";

test("AC1: a project with a Leader exists, the Leader has the Leader role, and it has the three default Sections", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "3.1 ac1" });
  const d = (await admin.api.get(`/api/projects/${p.id}`)).json.project;
  expect(d.sections.map((s: { name: string }) => s.name)).toEqual(["To do", "In progress", "Done"]);
  expect(d.sections.filter((s: { isDone: boolean }) => s.isDone)).toHaveLength(1);
  expect(d.members.find((m: { userId: string }) => m.userId === admin.user.id).role).toBe("LEADER");
});

test("AC1: the New project form creates a project and opens it (screen)", async ({ admin, later }) => {
  const name = zz("3.1 form");
  await admin.page.goto("/projects/new");
  await admin.page.getByLabel("Project name").fill(name);
  await admin.page.getByRole("button", { name: "Create project" }).click();
  await admin.page.waitForURL(/\/projects\/(?!new)[^/?]+/);
  const id = admin.page.url().match(/\/projects\/([^/?]+)/)![1];
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  await expect(admin.page.getByText(name).first()).toBeVisible();
  await expect(admin.page.getByText("You: Leader")).toBeVisible();
});

test("AC2: no Leader is refused by the server (an empty Leader says 'Choose a Leader.')", async ({ admin }) => {
  const none = await admin.api.post("/api/projects", { name: zz("3.1 noleader") });
  expect(none.status).toBe(400);
  const empty = await admin.api.post("/api/projects", { name: zz("3.1 emptyleader"), leaderId: "" });
  expect(empty.status).toBe(400);
  expect(JSON.stringify(empty.json)).toContain("Choose a Leader.");
});

test("AC2: the Leader field on the form is pre-filled with the creator (screen)", async ({ admin }) => {
  await admin.page.goto("/projects/new");
  const sel = admin.page.getByLabel("Leader");
  await expect(sel).toBeVisible();
  await expect(sel.locator("option:checked")).toContainText("(you)", { timeout: 30_000 });
});

test("AC3: a deactivated person cannot be named Leader", async ({ admin }) => {
  const email = `zz-test-${RUN}-a@example.invalid`;
  const add = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `Gone ${RUN}`, email, role: "MEMBER" });
  expect(add.status, JSON.stringify(add.json)).toBe(201);
  const id = add.json.person.id as string;
  const off = await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
  expect(off.status, JSON.stringify(off.json)).toBe(200);
  const r = await admin.api.post("/api/projects", { name: zz("3.1 inactive"), leaderId: id });
  expect(r.status).toBe(400);
});

test("AC4: a creator who names someone else as Leader becomes an Editor and sees the project", async ({ admin, member, later }) => {
  // The Member creates the project and names the Super Admin as Leader.
  const p = await newProject(admin, later, { label: "3.1 ac4", creator: member, leader: admin });
  const d = (await member.api.get(`/api/projects/${p.id}`)).json.project;
  expect(d.members.find((m: { userId: string }) => m.userId === member.user.id).role).toBe("EDITOR");
  expect(d.members.find((m: { userId: string }) => m.userId === admin.user.id).role).toBe("LEADER");
  const mine = (await member.api.get("/api/projects")).json.projects as { id: string }[];
  expect(mine.some((x) => x.id === p.id)).toBe(true);
});
