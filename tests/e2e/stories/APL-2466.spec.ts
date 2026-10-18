// APL-2466 · [SHO-E2] People and roles. One test per acceptance criterion.
// Pam qa:TC: none on the issue. New people are named ZZ-TEST and deactivated afterwards.
// Sign-up uses SHO_QA_PASS. The file skips when that is unset.
// Sign-in checks use the Member account from the environment (its password is known here). Its role and status are put back.
import { test, login } from "../support";
import {
  PASS, passwordOk, alias, zz, RUN, gate, signUp, signInAs, personByEmail, deactivate,
  addPersonOnTeam, deactivateOnTeam, teamRow, makeProject, archiveProject, expect, type Api,
} from "./qa";

type Who = { api: Api; user: { id?: string; name?: string; email?: string } };

test.beforeAll(async ({ request }) => {
  test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  if (!PASS) return;
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  login("ADMIN");
  await gate(request);
});

async function taskFor(api: Api, projectId: string, assigneeId: string, title: string) {
  const r = await api.post(`/api/projects/${projectId}/tasks`, { title, assigneeId });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
}

/** An active ZZ-TEST person added by the Super Admin. Deactivated afterwards. No mailbox is required. */
async function added(admin: Who, later: (fn: () => Promise<unknown>) => void, label: string, role: "MEMBER" | "ADMIN" = "MEMBER") {
  const full = zz(label);
  const space = full.indexOf(" ");
  const r = await admin.api.post("/api/team", {
    firstName: full.slice(0, space),
    lastName: full.slice(space + 1),
    email: `zz-test-${RUN}-${label}@example.invalid`,
    role,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(async () => {
    const status = (await admin.api.get(`/api/team/${id}`)).json.person?.status;
    if (status !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
  });
  return { id, name: r.json.person.name as string, email: r.json.person.email as string };
}

/** Deactivate someone who may still lead a project: hand that project to the Super Admin first, and remember it. */
async function deactivatePerson(admin: Who, personId: string, parked: string[]) {
  let off = await admin.api.post(`/api/team/${personId}/deactivate`, { reassign: "leaders" });
  const leads = (off.json.leads ?? []) as { id: string }[];
  if (off.status === 409 && leads.length) {
    for (const lead of leads) {
      const join = await admin.api.post(`/api/projects/${lead.id}/members`, { userId: admin.user.id, role: "EDITOR" });
      expect([201, 409], JSON.stringify(join.json)).toContain(join.status);
      const moved = await admin.api.post(`/api/projects/${lead.id}/leader`, { newLeaderId: admin.user.id, previousRole: "EDITOR" });
      expect(moved.status, JSON.stringify(moved.json)).toBe(200);
      parked.push(lead.id);
    }
    off = await admin.api.post(`/api/team/${personId}/deactivate`, { reassign: "leaders" });
  }
  return off;
}

test("AC1: the configured first Super Admin has the Super Admin role, and a new sign-up does not", async ({ admin, anon, later }) => {
  // A fresh database is not created here. The configured account (from SUPER_ADMIN_EMAILS) is that first Super Admin.
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

test("AC2: the Super Admin can promote a Member to Admin and demote them, and the person is notified", async ({ admin, browser, later }) => {
  test.setTimeout(120_000);
  const creds = login("MEMBER");
  const member = await signInAs(browser, creds.email, creds.password);
  later(() => member.ctx.close());
  const id = member.user.id as string;
  const before = (await admin.api.get(`/api/team/${id}`)).json.person.orgRole as "MEMBER" | "ADMIN";
  later(() => admin.api.patch(`/api/team/${id}`, { orgRole: before === "ADMIN" ? "ADMIN" : "MEMBER" }));
  if (before !== "MEMBER") expect((await admin.api.patch(`/api/team/${id}`, { orgRole: "MEMBER" })).status).toBe(200);

  const promoted = `${admin.user.name} changed your role to admin.`;
  const demoted = `${admin.user.name} changed your role to member.`;
  const countOf = async (text: string) => {
    const items = (await member.api.get("/api/notifications")).json.items as { text: string }[];
    return items.filter((n) => n.text === text).length;
  };
  const promotedBefore = await countOf(promoted);
  const up = await admin.api.patch(`/api/team/${id}`, { orgRole: "ADMIN" });
  expect(up.status, JSON.stringify(up.json)).toBe(200);
  expect((await personByEmail(admin.api, creds.email))?.orgRole).toBe("ADMIN");
  expect(await countOf(promoted)).toBe(promotedBefore + 1);

  const demotedBefore = await countOf(demoted);
  const down = await admin.api.patch(`/api/team/${id}`, { orgRole: "MEMBER" });
  expect(down.status).toBe(200);
  expect((await personByEmail(admin.api, creds.email))?.orgRole).toBe("MEMBER");
  expect(await countOf(demoted)).toBe(demotedBefore + 1);
});

test("AC3: deactivating a person blocks sign-in and keeps the record; reactivating restores access", async ({ admin, browser, anon, later }) => {
  test.setTimeout(180_000);
  const creds = login("MEMBER");
  const member = await signInAs(browser, creds.email, creds.password);
  later(() => member.ctx.close());
  const id = member.user.id as string;
  const parked: string[] = [];
  later(async () => {
    const status = (await admin.api.get(`/api/team/${id}`)).json.person?.status;
    if (status === "DEACTIVATED") await admin.api.post(`/api/team/${id}/reactivate`);
    for (const projectId of parked) {
      await admin.api.post(`/api/projects/${projectId}/leader`, { newLeaderId: id, previousRole: "EDITOR" });
    }
  });

  const off = await deactivatePerson(admin, id, parked);
  expect(off.status, JSON.stringify(off.json)).toBe(200);
  const kept = await personByEmail(admin.api, creds.email);
  expect(kept?.status).toBe("DEACTIVATED");
  expect(kept?.id).toBe(id);
  expect((await member.api.get("/api/auth/me")).status).toBe(401);
  const blocked = await anon.request.post("/api/auth/signin", { data: { email: creds.email, password: creds.password } });
  const body = await blocked.text();
  expect(body.includes(creds.password)).toBe(false);
  expect(blocked.status()).toBe(403);
  expect(JSON.parse(body).error).toBe("This account is deactivated.");

  expect((await admin.api.post(`/api/team/${id}/reactivate`)).status).toBe(200);
  const back = await signInAs(browser, creds.email, creds.password);
  later(() => back.ctx.close());
  expect(back.user.id).toBe(id);
});

test("AC4: open tasks move to a chosen receiver, and a receiver outside the project falls back to the Leader", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const leaver = await added(admin, later, "ac4-leave");
  const taker = await added(admin, later, "ac4-take");
  const outsider = await added(admin, later, "ac4-out");
  const project = await makeProject(admin.api, "ac4", admin.user.id as string);
  later(() => archiveProject(admin.api, project.id, admin.user.id as string));
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: leaver.id, role: "EDITOR" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: taker.id, role: "EDITOR" })).status).toBe(201);
  const taskId = await taskFor(admin.api, project.id, leaver.id, zz("handed"));

  const moved = await admin.api.post(`/api/team/${leaver.id}/deactivate`, { reassign: taker.id });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  expect(moved.json.fellBack).toEqual([]);
  expect((await admin.api.get(`/api/tasks/${taskId}`)).json.task.assignee.id).toBe(taker.id);

  const second = await makeProject(admin.api, "ac4b", admin.user.id as string);
  later(() => archiveProject(admin.api, second.id, admin.user.id as string));
  const other = await added(admin, later, "ac4-other");
  expect((await admin.api.post(`/api/projects/${second.id}/members`, { userId: other.id, role: "EDITOR" })).status).toBe(201);
  const stayed = await taskFor(admin.api, second.id, other.id, zz("stays"));
  const fell = await admin.api.post(`/api/team/${other.id}/deactivate`, { reassign: outsider.id });
  expect(fell.status, JSON.stringify(fell.json)).toBe(200);
  expect(fell.json.fellBack).toContain(second.name);
  expect((await personByEmail(admin.api, other.email))?.status).toBe("DEACTIVATED");
  const assigneeId = (await admin.api.get(`/api/tasks/${stayed}`)).json.task.assignee.id as string;
  expect(assigneeId, "the open task goes to the project Leader").toBe(admin.user.id);
  expect(assigneeId).not.toBe(outsider.id);
  const members = (await admin.api.get(`/api/projects/${second.id}`)).json.project.members as { userId: string; role: string }[];
  expect(["LEADER", "EDITOR"]).toContain(members.find((member) => member.userId === assigneeId)?.role);
});

const zzEmail = (label: string) => `zz-test-${RUN}-${label}@example.invalid`;

async function retire(api: Api, email: string) {
  const person = await personByEmail(api, email);
  if (person && person.status !== "DEACTIVATED") await deactivate(api, person.id);
}

test("AC5: the only Super Admin cannot be demoted or deactivated", async ({ admin, later }) => {
  test.setTimeout(240_000);
  const id = admin.user.id as string;
  const demote = await admin.api.patch(`/api/team/${id}`, { orgRole: "MEMBER" });
  expect(demote.status).toBe(403);
  expect(demote.json.error).toBe("The Super Admin role is set in server configuration only.");
  const off = await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
  expect(off.status).toBeGreaterThanOrEqual(400);
  expect(String(off.json.error)).toMatch(/cannot deactivate/);
  expect((await admin.api.get("/api/auth/me")).json.user.orgRole).toBe("SUPER_ADMIN");

  const name = zz("ac5");
  const email = zzEmail("ac5");
  const space = name.indexOf(" ");
  later(() => retire(admin.api, email));
  await addPersonOnTeam(admin.page, name.slice(0, space), name.slice(space + 1), email);
  const created = teamRow(admin.page, email);
  await expect(created).toHaveCount(1, { timeout: 90_000 });
  await expect(created.getByRole("button", { name: "Deactivate" })).toBeVisible();
  await deactivateOnTeam(admin.page, name);

  const mine = teamRow(admin.page, String(admin.user.email));
  await expect(mine).toHaveCount(1);
  await expect(mine.locator(".chip", { hasText: "Super Admin" })).toBeVisible();
  await expect(mine.getByRole("button", { name: /Deactivate|Make Member|Make Admin|Reactivate/ })).toHaveCount(0);
});

test("AC6: the Team page shows people by role, and deactivated people are shown as deactivated", async ({ admin, later }) => {
  test.setTimeout(240_000);
  const memberName = zz("ac6-member");
  const adminName = zz("ac6-admin");
  const memberEmail = zzEmail("ac6-member");
  const adminEmail = zzEmail("ac6-admin");
  const split = (full: string) => {
    const space = full.indexOf(" ");
    return [full.slice(0, space), full.slice(space + 1)] as const;
  };
  later(async () => {
    await retire(admin.api, memberEmail);
    await retire(admin.api, adminEmail);
  });
  const [memberFirst, memberLast] = split(memberName);
  const [adminFirst, adminLast] = split(adminName);
  await addPersonOnTeam(admin.page, memberFirst, memberLast, memberEmail);
  await addPersonOnTeam(admin.page, adminFirst, adminLast, adminEmail, "ADMIN");
  await deactivateOnTeam(admin.page, memberName);

  await expect(admin.page.locator("#main table").getByRole("columnheader", { name: "Role", exact: true })).toHaveCount(1);
  const memberRow = teamRow(admin.page, memberEmail);
  const adminRow = teamRow(admin.page, adminEmail);
  await expect(memberRow).toHaveCount(1);
  await expect(adminRow).toHaveCount(1);
  await expect(memberRow.locator(".chip", { hasText: "Member" })).toBeVisible();
  await expect(memberRow.locator(".chip.grey", { hasText: "Deactivated" })).toBeVisible();
  await expect(adminRow.locator(".chip", { hasText: "Admin" })).toBeVisible();
  const mine = teamRow(admin.page, String(admin.user.email));
  await expect(mine).toHaveCount(1);
  await expect(mine.locator(".chip", { hasText: "Super Admin" })).toBeVisible();
});
