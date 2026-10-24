// SHO-US-3.2 Access follows membership (Linear APL-2486).
// The plain Member (SHO_MEMBER_*) is the other person. A person in no projects is a fresh sign-up when the mail sink has the verification link.
import { readFileSync } from "node:fs";
import { test, expect, zz } from "../support";
import { quickAction } from "../helpers/jim-http";
import { newProject, newTask } from "../g2";
import { PASS, passwordOk, alias, signUp, sinkToken, signInAs, deactivate } from "./qa";

test("AC1: a Member in two projects sees only those two, and cannot read another project by ID", async ({ admin, member, later }) => {
  const a = await newProject(admin, later, { label: "3.2 A", members: [{ who: member }] });
  const b = await newProject(admin, later, { label: "3.2 B", members: [{ who: member }] });
  const c = await newProject(admin, later, { label: "3.2 C (member not in it)" });
  const t = await newTask(admin, c.id, { title: zz("3.2 secret task") });
  const ids = ((await member.api.get("/api/projects")).json.projects as { id: string }[]).map((p) => p.id);
  expect(ids).toContain(a.id);
  expect(ids).toContain(b.id);
  expect(ids).not.toContain(c.id);
  expect((await member.api.get(`/api/projects/${c.id}`)).status).toBe(404);
  expect((await member.api.get(`/api/projects/${c.id}/tasks`)).status).toBe(404);
  expect((await member.api.get(`/api/tasks/${t}`)).status).toBe(404);
});

test("AC2: a person in no projects sees 'Ask a project Leader to add you.' (screen)", async ({ browser, anon, admin, later }) => {
  const view = readFileSync("src/app/(app)/projects/ProjectsView.tsx", "utf8");
  expect(view).toContain("Ask a project Leader to add you.");
  const list = readFileSync("src/lib/projects.ts", "utf8");
  const fn = list.slice(list.indexOf("export async function listProjects"), list.indexOf("export async function getProject"));
  expect(fn).toContain("isAdmin(user) ? {} : { members: { some: { userId: user.id } } }");
  if (!PASS || !passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters with a letter and a number).");
  const email = alias("2486", "empty", "aplyd.com");
  const signed = await signUp(anon.request, zz("2486 empty"), email);
  expect(signed.status, signed.body).toBe(201);
  const token = await sinkToken(email, "Verify");
  if (!token) {
    const person = ((await admin.api.get("/api/team")).json.people as { id: string; email?: string }[]).find((p) => p.email?.toLowerCase() === email);
    if (person) later(() => deactivate(admin.api, person.id));
    test.info().annotations.push({ type: "mail", description: "No verification link in the mail sink. The empty-state sentence and the membership filter are checked from the source." });
    return;
  }
  expect((await anon.request.post("/api/auth/verify", { data: { token } })).ok()).toBe(true);
  const who = await signInAs(browser, email, PASS);
  later(() => who.ctx.close());
  later(() => deactivate(admin.api, who.user.id as string));
  const mine = (await who.api.get("/api/projects")).json.projects as unknown[];
  expect(mine).toEqual([]);
  await who.page.goto("/projects");
  await expect(who.page.getByText("Ask a project Leader to add you.")).toBeVisible();
});

test("AC3: the Super Admin lists a project they are not a member of, and can act in it", async ({ admin, member, later }) => {
  // The Member leads it; the Super Admin is not in its member list.
  const p = await newProject(admin, later, { label: "3.2 admin sees", creator: member, leader: member });
  const d = (await admin.api.get(`/api/projects/${p.id}`)).json.project;
  expect(d.members.some((m: { userId: string }) => m.userId === admin.user.id)).toBe(false);
  const all = ((await admin.api.get("/api/projects")).json.projects as { id: string }[]).map((x) => x.id);
  expect(all).toContain(p.id);
  const r = await admin.api.post(`/api/projects/${p.id}/tasks`, { title: zz("3.2 admin task") });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
});

test("AC4: a Member requesting a project they are not in gets 'not found', not 'forbidden'", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "3.2 ac4" });
  const r = await member.api.get(`/api/projects/${p.id}`);
  expect(r.status).toBe(404);
  const w = await member.api.post(`/api/projects/${p.id}/tasks`, { title: zz("x") });
  expect(w.status).toBe(404);
});

test("AC5: an archived project stays readable to its members, hidden from non-members, and refuses changes", async ({ admin, member, later }) => {
  const mem = await newProject(admin, later, { label: "3.2 archived (member in)", members: [{ who: member }] });
  const out = await newProject(admin, later, { label: "3.2 archived (member out)" });
  const t = await newTask(admin, mem.id);
  expect((await admin.api.post(`/api/projects/${mem.id}/archive`)).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${out.id}/archive`)).status).toBe(200);
  expect((await member.api.get(`/api/projects/${mem.id}`)).status).toBe(200);
  expect((await member.api.get(`/api/tasks/${t}`)).status).toBe(200);
  expect((await member.api.get(`/api/projects/${out.id}`)).status).toBe(404);
  const archivedList = ((await member.api.get("/api/projects?archived=true")).json.projects as { id: string }[]).map((p) => p.id);
  expect(archivedList).toContain(mem.id);
  expect(archivedList).not.toContain(out.id);
  expect((await admin.api.patch(`/api/tasks/${t}`, { title: zz("changed") })).status).toBe(409);
  expect((await admin.api.post(`/api/projects/${mem.id}/tasks`, { title: zz("new") })).status).toBe(409);
});

test("AC6: search shows a Member nothing from a project they are not in (archived ones only when asked)", async ({ admin, member, later }) => {
  const word = `zzsearch${Date.now().toString(36)}`;
  const mine = await newProject(admin, later, { label: "3.2 search mine", members: [{ who: member }] });
  const secret = await newProject(admin, later, { label: "3.2 search secret" });
  await newTask(admin, mine.id, { title: `${word} visible`, assigneeId: member.user.id });
  await newTask(admin, secret.id, { title: `${word} hidden` });
  const old = await newProject(admin, later, { label: "3.2 search archived", members: [{ who: member }] });
  await newTask(admin, old.id, { title: `${word} archived task`, assigneeId: member.user.id });
  expect((await admin.api.post(`/api/projects/${old.id}/archive`)).status).toBe(200);
  const titles = async (extra = "") => ((await member.api.get(`/api/search?q=${word}${extra}`)).json.tasks as { title: string }[]).map((t) => t.title);
  expect(await titles()).toEqual([`${word} visible`]);
  expect((await titles("&archived=true")).sort()).toEqual([`${word} archived task`, `${word} visible`]);
  expect((await member.api.get("/api/search?q=z")).json.tasks).toHaveLength(0); // under 2 characters
});

test("AC6 (concierge half): a quick action on a project the person is not in is Project not found and does not name it", async ({ admin, member, later }) => {
  const visible = await newProject(admin, later, { label: "3.2 concierge visible", members: [{ who: member }] });
  const allowed = await quickAction(member, "due-week", visible.id);
  expect(allowed.status, allowed.body).toBe(200);
  const secret = await newProject(admin, later, { label: "3.2 concierge secret" });
  const r = await quickAction(member, "due-week", secret.id);
  expect(r.status, r.body).toBe(404);
  expect(r.json.error).toBe("Project not found");
  expect(r.body.includes(secret.name)).toBe(false);
});
