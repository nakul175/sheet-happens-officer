// APL-2466 · [SHO-E2] People and roles. One test per acceptance criterion.
// qa:TC: unpublished. No test-case id of the form qa:TC-APL2466-<hash> exists in this repo or in its history, so
// each title ends "qa:TC missing". Replace that marker with the real id when it is published; never invent one.
// Password comes from SHO_QA_PASS. Names use ZZ-TEST. Emails are nakul17+ aliases.
import { test, login } from "../support";
import {
  PASS, passwordOk, alias, zz, gate, signUp, signInAs, verifiedUser, personByEmail, deactivate,
  makeProject, archiveProject, expect, type Api,
} from "./qa";

test.beforeAll(async ({ request }) => {
  if (!PASS) throw new Error("Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  login("ADMIN");
  await gate(request);
});

async function taskFor(api: Api, projectId: string, assigneeId: string, title: string) {
  const r = await api.post(`/api/projects/${projectId}/tasks`, { title, assigneeId });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
}

test("AC1: the configured first Super Admin has the Super Admin role, and a new sign-up does not qa:TC missing", async ({ admin, anon, later }) => {
  // A fresh database is not created here. The configured account (SHO_ADMIN_EMAIL, from SUPER_ADMIN_EMAILS) is that first Super Admin.
  const me = await admin.api.get("/api/auth/me");
  expect(me.json.user.orgRole).toBe("SUPER_ADMIN");
  const row = await personByEmail(admin.api, String(admin.user.email));
  expect(row?.orgRole).toBe("SUPER_ADMIN");

  const email = alias("2466", "ac1", "aplyd.com");
  const signed = await signUp(anon.request, zz("ac1"), email);
  expect(signed.status, signed.body).toBe(201);
  const person = await personByEmail(admin.api, email);
  expect(person?.orgRole).toBe("MEMBER");
  later(() => deactivate(admin.api, person!.id));
});

test("AC2: the Super Admin can promote a Member to Admin and demote them, and the person is notified qa:TC missing", async ({ admin, browser, anon, later }) => {
  const member = await verifiedUser(browser, anon.request, "2466", "ac2");
  later(() => member.ctx.close());
  later(() => deactivate(admin.api, member.user.id as string));

  const up = await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "ADMIN" });
  expect(up.status, JSON.stringify(up.json)).toBe(200);
  expect((await personByEmail(admin.api, member.email))?.orgRole).toBe("ADMIN");
  const notes = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  expect(notes.some((n) => n.text === `${admin.user.name} changed your role to admin.`)).toBe(true);

  const down = await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" });
  expect(down.status).toBe(200);
  expect((await personByEmail(admin.api, member.email))?.orgRole).toBe("MEMBER");
  const again = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  expect(again.some((n) => n.text === `${admin.user.name} changed your role to member.`)).toBe(true);
});

test("AC3: deactivating a person blocks sign-in and keeps the record; reactivating restores access qa:TC missing", async ({ admin, browser, anon, later }) => {
  const member = await verifiedUser(browser, anon.request, "2466", "ac3");
  later(() => member.ctx.close());
  later(() => deactivate(admin.api, member.user.id as string));

  const off = await admin.api.post(`/api/team/${member.user.id}/deactivate`, { reassign: "leaders" });
  expect(off.status, JSON.stringify(off.json)).toBe(200);
  const kept = await personByEmail(admin.api, member.email);
  expect(kept?.status).toBe("DEACTIVATED");
  expect(kept?.id).toBe(member.user.id);
  const blocked = await anon.request.post("/api/auth/signin", { data: { email: member.email, password: PASS } });
  const body = await blocked.text();
  const pass = PASS;
  expect(body.includes(pass)).toBe(false);
  expect(blocked.status()).toBe(403);
  expect(JSON.parse(body).error).toBe("This account is deactivated.");

  expect((await admin.api.post(`/api/team/${member.user.id}/reactivate`)).status).toBe(200);
  const back = await signInAs(browser, member.email, PASS);
  later(() => back.ctx.close());
  expect(back.user.id).toBe(member.user.id);
});

test("AC4: open tasks move to a chosen receiver, and a receiver outside the project falls back to the Leader qa:TC missing", async ({ admin, browser, anon, later }) => {
  const leaver = await verifiedUser(browser, anon.request, "2466", "ac4-leave");
  const taker = await verifiedUser(browser, anon.request, "2466", "ac4-take");
  const outsider = await verifiedUser(browser, anon.request, "2466", "ac4-out");
  for (const w of [leaver, taker, outsider]) {
    later(() => w.ctx.close());
    later(() => deactivate(admin.api, w.user.id as string));
  }
  const project = await makeProject(admin.api, "ac4", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: leaver.user.id, role: "EDITOR" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: taker.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz("handed");
  const taskId = await taskFor(admin.api, project.id, leaver.user.id as string, title);

  const moved = await admin.api.post(`/api/team/${leaver.user.id}/deactivate`, { reassign: taker.user.id });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  expect(moved.json.fellBack).toEqual([]);
  expect((await admin.api.get(`/api/tasks/${taskId}`)).json.task.assignee.id).toBe(taker.user.id);

  const second = await makeProject(admin.api, "ac4b", admin.user.id as string);
  later(() => archiveProject(admin.api, second.id, admin.user.id as string));
  const other = await verifiedUser(browser, anon.request, "2466", "ac4-other");
  later(() => other.ctx.close());
  later(() => deactivate(admin.api, other.user.id as string));
  expect((await admin.api.post(`/api/projects/${second.id}/members`, { userId: other.user.id, role: "EDITOR" })).status).toBe(201);
  const stayed = await taskFor(admin.api, second.id, other.user.id as string, zz("stays"));
  const fell = await admin.api.post(`/api/team/${other.user.id}/deactivate`, { reassign: outsider.user.id });
  expect(fell.status, JSON.stringify(fell.json)).toBe(200);
  expect(fell.json.fellBack).toContain(second.name);
  expect((await personByEmail(admin.api, other.email))?.status).toBe("DEACTIVATED");
  const assigneeId = (await admin.api.get(`/api/tasks/${stayed}`)).json.task.assignee.id as string;
  expect(assigneeId, "the open task goes to the project Leader").toBe(admin.user.id);
  expect(assigneeId).not.toBe(outsider.user.id);
  const members = (await admin.api.get(`/api/projects/${second.id}`)).json.project.members as { userId: string; role: string }[];
  expect(["LEADER", "EDITOR"]).toContain(members.find((member) => member.userId === assigneeId)?.role);
});

test("AC5: the only Super Admin cannot be demoted or deactivated qa:TC missing", async ({ admin }) => {
  const id = admin.user.id as string;
  const demote = await admin.api.patch(`/api/team/${id}`, { orgRole: "MEMBER" });
  expect(demote.status).toBe(403);
  expect(demote.json.error).toBe("The Super Admin role is set in server configuration only.");
  const off = await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
  expect(off.status).toBeGreaterThanOrEqual(400);
  expect(String(off.json.error)).toMatch(/cannot deactivate/);
  expect((await admin.api.get("/api/auth/me")).json.user.orgRole).toBe("SUPER_ADMIN");
  await admin.page.goto("/team");
  const mine = admin.page.locator("tr", { hasText: String(admin.user.email) }).first();
  await expect(mine).toContainText("Super Admin");
  await expect(mine.getByRole("button", { name: /Deactivate|Make Member/ })).toHaveCount(0);
});

test("AC6: the Team page shows people by role, and deactivated people are shown as deactivated qa:TC missing", async ({ admin, browser, anon, later }) => {
  const member = await verifiedUser(browser, anon.request, "2466", "ac6-member");
  const orgAdmin = await verifiedUser(browser, anon.request, "2466", "ac6-admin");
  later(() => member.ctx.close());
  later(() => orgAdmin.ctx.close());
  later(() => deactivate(admin.api, member.user.id as string));
  later(() => deactivate(admin.api, orgAdmin.user.id as string));
  expect((await admin.api.patch(`/api/team/${orgAdmin.user.id}`, { orgRole: "ADMIN" })).status).toBe(200);
  expect((await admin.api.post(`/api/team/${member.user.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);

  await admin.page.goto("/team");
  await expect(admin.page.getByRole("columnheader", { name: "Role" })).toBeVisible();
  const memberRow = admin.page.locator("tr", { hasText: member.name });
  const adminRow = admin.page.locator("tr", { hasText: orgAdmin.name });
  await expect(memberRow).toContainText("Member");
  await expect(memberRow).toContainText("Deactivated");
  await expect(memberRow.locator(".chip.grey", { hasText: "Deactivated" })).toBeVisible();
  await expect(adminRow).toContainText("Admin");
  await expect(admin.page.locator("tr", { hasText: String(admin.user.email) }).first()).toContainText("Super Admin");
});
