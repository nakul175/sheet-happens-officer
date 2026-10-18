// SHO-US-2.3 Deactivate and reactivate people (APL-2482). Acceptance criteria AC1 to AC3.
// Session checks use a ZZ-TEST person when the test mail sink has their password.
// Otherwise they use the Member account from the environment, and that account is restored afterwards.
import type { Browser } from "@playwright/test";
import { test, expect, RUN, login, zz, type Api, type Json } from "../support";
import { PASS, alias, BASE_URL, passwordOk, signInAs, sinkText } from "./qa";

type Ctx = { api: Api; user: Json };
async function person(admin: Ctx, later: (f: () => Promise<unknown>) => void, label: string, role: "MEMBER" | "ADMIN" = "MEMBER") {
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email: `zz-test-${RUN}-${label}@example.invalid`, role });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(async () => { const s = (await admin.api.get(`/api/team/${id}`)).json.person?.status; if (s !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
  return { id, name: `ZZ-TEST ${label} ${RUN}` };
}
async function project(admin: Ctx, later: (f: () => Promise<unknown>) => void, label: string) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return id;
}
const statusOf = async (admin: Ctx, id: string) => (await admin.api.get(`/api/team/${id}`)).json.person.status as string;

/** Deactivate someone who may still lead a project. Leadership is handed to the Super Admin and listed in `parked` so it can be put back. */
async function deactivatePerson(admin: Ctx, personId: string, parked: string[]) {
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

/** The Member account from the environment. Role and status are restored by `later`. */
async function openMember(browser: Browser, admin: Ctx, later: (f: () => Promise<unknown>) => void) {
  const creds = login("MEMBER");
  const who = await signInAs(browser, creds.email, creds.password);
  later(() => who.ctx.close());
  const id = who.user.id as string;
  const parked: string[] = [];
  later(async () => {
    const status = (await admin.api.get(`/api/team/${id}`)).json.person?.status;
    if (status === "DEACTIVATED") await admin.api.post(`/api/team/${id}/reactivate`);
    for (const projectId of parked) await admin.api.post(`/api/projects/${projectId}/leader`, { newLeaderId: id, previousRole: "EDITOR" });
  });
  return { creds, who, id, parked };
}

test.describe("SHO-US-2.3 / APL-2482", () => {
  test.beforeAll(() => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    if (!PASS) return;
    if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  });

  test("AC1: an Admin deactivates a Member: they are kept (never deleted), cannot be given new tasks, and their open tasks are handed over", async ({ admin, later }) => {
    const p = await person(admin, later, "leaver");
    const proj = await project(admin, later, "2.3 ac1");
    expect((await admin.api.post(`/api/projects/${proj}/members`, { userId: p.id, role: "EDITOR" })).status).toBe(201);
    const t = await admin.api.post(`/api/projects/${proj}/tasks`, { title: zz("leaver task"), assigneeId: p.id });
    expect(t.status).toBe(201);
    const taskId = t.json.task.id as string;

    const d = await admin.api.post(`/api/team/${p.id}/deactivate`, { reassign: "leaders" });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json.moved).toBeGreaterThanOrEqual(1);
    expect(await statusOf(admin, p.id)).toBe("DEACTIVATED"); // history kept: the person is still there
    const row = (await admin.api.get("/api/team")).json.people.find((x: Json) => x.id === p.id);
    expect(row?.status).toBe("DEACTIVATED");

    // They cannot be assigned new tasks. The version is sent so the refusal is the assignee rule, not a missing version.
    const seen = (await admin.api.get(`/api/tasks/${taskId}`)).json.task.updatedAt;
    const assign = await admin.api.post(`/api/tasks/${taskId}/assign`, { assigneeId: p.id, expectedUpdatedAt: seen });
    expect(assign.status, JSON.stringify(assign.json)).toBeGreaterThanOrEqual(400);
    // Prohibited: any hard delete.
    expect([404, 405]).toContain((await admin.api.del(`/api/team/${p.id}`)).status);
  });

  test("AC1 (sessions and sign-in): their sessions end and they cannot sign in", async ({ admin, browser, later }) => {
    test.setTimeout(180_000);
    const email = alias("2482", "session");
    const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `session ${RUN}`, email, role: "MEMBER" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const createdId = r.json.person.id as string;
    later(async () => {
      const s = (await admin.api.get(`/api/team/${createdId}`)).json.person?.status;
      if (s && s !== "DEACTIVATED") await admin.api.post(`/api/team/${createdId}/deactivate`, { reassign: "leaders" });
    });
    const text = await sinkText(email, "Your Sheet Happens Officer account");
    const mailed = text?.match(/^Password: (.+)$/m)?.[1];

    const ctx = await browser.newContext({
      baseURL: BASE_URL,
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    });
    later(() => ctx.close());
    let id = createdId;
    let password = mailed;
    if (!password) {
      const member = await openMember(browser, admin, later);
      id = member.id;
      password = member.creds.password;
      const parked = member.parked;
      const off = await deactivatePerson(admin, id, parked);
      expect(off.status, JSON.stringify(off.json)).toBe(200);
      expect((await member.who.api.get("/api/auth/me")).status).toBe(401);
      const refused = await ctx.request.post("/api/auth/signin", { data: { email: member.creds.email, password } });
      const body = await refused.text();
      expect(body.includes(password)).toBe(false);
      expect(refused.status()).toBe(403);
      expect(JSON.parse(body).error).toBe("This account is deactivated.");
      return;
    }
    const signed = await ctx.request.post("/api/auth/signin", { data: { email, password } });
    const signedBody = await signed.text();
    expect(signedBody.includes(password)).toBe(false);
    expect(signed.ok(), String(signed.status())).toBe(true);
    expect((await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    expect((await ctx.request.get("/api/auth/me")).status()).toBe(401);
    const refused = await ctx.request.post("/api/auth/signin", { data: { email, password } });
    const body = await refused.text();
    expect(body.includes(password)).toBe(false);
    expect(refused.status()).toBe(403);
    expect(JSON.parse(body).error).toBe("This account is deactivated.");
  });

  test("AC2: only the Super Admin can act on Admins; a Member cannot act on anyone; nobody can deactivate a Super Admin", async ({ admin, member, later }) => {
    const adminPerson = await person(admin, later, "adminrole", "ADMIN");
    const plain = await person(admin, later, "plainrole");
    // A Member may not deactivate an Admin or a Member.
    expect((await member.api.post(`/api/team/${adminPerson.id}/deactivate`, { reassign: "leaders" })).status).toBe(403);
    expect((await member.api.post(`/api/team/${plain.id}/deactivate`, { reassign: "leaders" })).status).toBe(403);
    expect(await statusOf(admin, adminPerson.id)).toBe("ACTIVE");
    // Nobody deactivates the Super Admin in the app.
    expect((await member.api.post(`/api/team/${admin.user.id}/deactivate`, { reassign: "leaders" })).status).toBe(403);
    expect([403, 409]).toContain((await admin.api.post(`/api/team/${admin.user.id}/deactivate`, { reassign: "leaders" })).status);
    expect((await admin.api.get("/api/auth/me")).json.user.orgRole).toBe("SUPER_ADMIN");
    // The Super Admin can act on an Admin, and a Member cannot undo it.
    expect((await admin.api.post(`/api/team/${adminPerson.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    expect((await member.api.post(`/api/team/${adminPerson.id}/reactivate`)).status).toBe(403);
    expect(await statusOf(admin, adminPerson.id)).toBe("DEACTIVATED");
  });

  test("AC2 (Admin acting on an Admin): an Admin who is not the Super Admin is refused, for deactivating and for reactivating", async ({ admin, member, later }) => {
    // The plain Member is made an Admin for the length of this test only. The role is put back in the finally block and again by `later`.
    later(() => admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" }));
    const target = await person(admin, later, "adminfoe", "ADMIN");
    expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "ADMIN" })).status).toBe(200);
    try {
      expect((await member.api.post(`/api/team/${target.id}/deactivate`, { reassign: "leaders" })).status, "an Admin may not deactivate an Admin").toBe(403);
      expect(await statusOf(admin, target.id)).toBe("ACTIVE");
      expect((await admin.api.post(`/api/team/${target.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
      expect((await member.api.post(`/api/team/${target.id}/reactivate`)).status, "an Admin may not reactivate an Admin").toBe(403);
      expect(await statusOf(admin, target.id)).toBe("DEACTIVATED");
    } finally {
      await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" });
    }
  });

  test("AC3: reactivating restores the person and their old project membership, but does not hand reassigned tasks back", async ({ admin, later }) => {
    const p = await person(admin, later, "returner");
    const proj = await project(admin, later, "2.3 ac3");
    await admin.api.post(`/api/projects/${proj}/members`, { userId: p.id, role: "EDITOR" });
    const t = await admin.api.post(`/api/projects/${proj}/tasks`, { title: zz("returner task"), assigneeId: p.id });
    const taskId = t.json.task.id as string;
    expect((await admin.api.post(`/api/team/${p.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);

    const re = await admin.api.post(`/api/team/${p.id}/reactivate`);
    expect(re.status).toBe(200);
    expect(await statusOf(admin, p.id)).toBe("ACTIVE");
    const members = (await admin.api.get(`/api/projects/${proj}`)).json.project.members as { userId: string; role: string }[];
    expect(members.find((m) => m.userId === p.id)?.role, "membership as it was").toBe("EDITOR");
    const task = (await admin.api.get(`/api/tasks/${taskId}`)).json.task;
    expect(task.assignee.id, "the task stays with the person it was handed to").toBe(admin.user.id);
    // Reactivating someone who is already active is refused.
    expect((await admin.api.post(`/api/team/${p.id}/reactivate`)).status).toBe(409);
  });

  test("AC3 (sign-in): the reactivated person can sign in again", async ({ admin, browser, later }) => {
    test.setTimeout(180_000);
    const email = alias("2482", "back");
    const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `back ${RUN}`, email, role: "MEMBER" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const createdId = r.json.person.id as string;
    later(async () => {
      const s = (await admin.api.get(`/api/team/${createdId}`)).json.person?.status;
      if (s && s !== "DEACTIVATED") await admin.api.post(`/api/team/${createdId}/deactivate`, { reassign: "leaders" });
    });
    const text = await sinkText(email, "Your Sheet Happens Officer account");
    const mailed = text?.match(/^Password: (.+)$/m)?.[1];
    if (mailed) {
      expect((await admin.api.post(`/api/team/${createdId}/deactivate`, { reassign: "leaders" })).status).toBe(200);
      expect((await admin.api.post(`/api/team/${createdId}/reactivate`)).status).toBe(200);
      expect(await statusOf(admin, createdId)).toBe("ACTIVE");
      const back = await signInAs(browser, email, mailed);
      later(() => back.ctx.close());
      expect(back.user.id).toBe(createdId);
      return;
    }
    const member = await openMember(browser, admin, later);
    const off = await deactivatePerson(admin, member.id, member.parked);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(await statusOf(admin, member.id)).toBe("DEACTIVATED");
    expect((await admin.api.post(`/api/team/${member.id}/reactivate`)).status).toBe(200);
    expect(await statusOf(admin, member.id)).toBe("ACTIVE");
    const back = await signInAs(browser, member.creds.email, member.creds.password);
    later(() => back.ctx.close());
    expect(back.user.id).toBe(member.id);
  });
});
