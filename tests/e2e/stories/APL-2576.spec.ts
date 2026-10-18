// SHO-US-14.17 Create a project and add people in one flow (APL-2576).
// The people it adds are throw-away ZZ-TEST accounts on an unroutable address (example.invalid), deactivated at the end.
import { test, expect, zz, RUN, type Api } from "../support";

async function person(admin: { api: Api }, later: (f: () => Promise<unknown>) => void, label: string) {
  const last = `${label}-${RUN}`;
  const email = `zz-test-${label}-${RUN}@example.invalid`;
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: last, email, role: "MEMBER" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = (r.json.person?.id ?? r.json.user?.id ?? r.json.id) as string;
  expect(id).toBeTruthy();
  later(() => admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }));
  return { id, name: `ZZ-TEST ${last}` };
}

test("AC1 and AC2: a name plus three people in the New project form creates the project; people are Editors unless Viewer is chosen", async ({ admin, later }) => {
  const a = await person(admin, later, "a");
  const b = await person(admin, later, "b");
  const c = await person(admin, later, "c");
  const p = admin.page;
  const name = zz("kickoff");
  // steps from Projects: 1 open +New project, 2 type the name, 3 to 5 tick three people (one set to Viewer), 6 Create
  await p.goto("/projects");
  await p.getByRole("link", { name: "+ New project" }).click();
  await p.getByLabel("Project name").fill(name);
  const find = p.getByLabel("Find a person");
  for (const who of [a, b, c]) {
    if (await find.isVisible().catch(() => false)) await find.fill(who.name);
    await p.getByRole("group", { name: "People", exact: true }).getByLabel(who.name).check();
  }
  if (await find.isVisible().catch(() => false)) await find.fill(b.name); // show b again so its role can be changed
  await p.getByLabel(`Role of ${b.name}`).selectOption("VIEWER");
  await p.getByRole("button", { name: "Create project" }).click();
  await expect(p).toHaveURL(/\/projects\/(?!new)[a-z0-9]+/); // the page may drop ?new=1 once it has opened the first-task prompt
  const id = p.url().match(/\/projects\/([^/?]+)/)![1];
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  const proj = (await admin.api.get(`/api/projects/${id}`)).json.project;
  const role = (uid: string) => proj.members.find((m: { userId: string }) => m.userId === uid)?.role;
  expect(role(admin.user.id)).toBe("LEADER");
  expect(role(a.id)).toBe("EDITOR");
  expect(role(b.id)).toBe("VIEWER");
  expect(role(c.id)).toBe("EDITOR");
  // after Create it asks for the first task
  await expect(p.getByRole("dialog")).toBeVisible();
  await expect(p.getByRole("dialog").getByLabel(/title|task/i).first()).toBeVisible();
});

test("AC3: a project with only me in it shows an 'Add people' banner until someone is added or I dismiss it", async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("alone"), leaderId: admin.user.id });
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  const banner = p.getByRole("region", { name: "Add people" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Add people" })).toHaveAttribute("href", `/projects/${id}/members`);
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
  await p.reload();
  await expect(p.getByRole("region", { name: "Add people" })).toHaveCount(0); // stays dismissed on this device

  // and it goes away on its own once someone joins
  const other = await person(admin, later, "d");
  const r2 = await admin.api.post("/api/projects", { name: zz("joined"), leaderId: admin.user.id });
  const id2 = r2.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id2}/archive`));
  expect((await admin.api.post(`/api/projects/${id2}/members`, { userId: other.id, role: "EDITOR" })).status).toBe(201);
  await p.goto(`/projects/${id2}`);
  await expect(p.getByRole("region", { name: "Add people" })).toHaveCount(0);
});

test("AC4: a deactivated person is not in the list", async ({ admin, later }) => {
  const gone = await person(admin, later, "e");
  expect((await admin.api.post(`/api/team/${gone.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
  const p = admin.page;
  await p.goto("/projects/new");
  await expect(p.getByRole("group", { name: "People", exact: true })).toBeVisible();
  const find = p.getByLabel("Find a person");
  if (await find.isVisible().catch(() => false)) await find.fill(gone.name);
  await expect(p.getByRole("group", { name: "People", exact: true }).getByLabel(gone.name)).toHaveCount(0);
  const bad = await admin.api.post("/api/projects", { name: zz("refused"), leaderId: admin.user.id, members: [{ userId: gone.id }] });
  expect(bad.status).toBe(400);
});
