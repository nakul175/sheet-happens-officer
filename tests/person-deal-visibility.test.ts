// APL-2728. The person page must follow the APL-2716 rule: a deal CRM_VISIBLE hides is generic
// text only, with no deal name and no href. These call getPerson in this process and flip
// CRM_VISIBLE; crmMode() reads it at call time. Setup uses the live server and a local database.
// Names are ZZ-TEST. Addresses are nakul17+ aliases.
import { afterAll, describe, expect, it } from "vitest";
import { crmMode } from "@/lib/crm";
import { getPerson } from "@/lib/team";
import { account, istDate, superAdmin, task, type Account } from "./helpers";

const HIDDEN_DEAL_LABEL = "A deal you can't view.";
const DEAL_NAME = "ZZ-TEST Acme renewal";
const TASK_TITLE = "ZZ-TEST Acme kickoff";
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];
const projectIds: string[] = [];

async function withMode<T>(mode: "all" | "admins" | "off", fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = mode;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = prev;
  }
}

async function zzAccount(role: string) {
  const n = seq++;
  const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "") || "user";
  const email = `nakul17+zz-2728-${RUN}-${slug}-${n}@aplyd.com`;
  const who = await account(`ZZ-TEST ${role} ${RUN}-${n}`, email);
  people.push(who);
  return who;
}

const actor = (who: Account, orgRole: "MEMBER" | "ADMIN" | "SUPER_ADMIN") => ({ id: who.id, orgRole });

describe("qa:TC missing APL-2728 person page hides a deal CRM_VISIBLE conceals", () => {
  let member: Account;
  let adminUser: Account;
  let outsider: Account;
  let dealId = "";
  let plainId = "";
  let plainName = "";
  let stageName = "";
  let organisationId = "";
  let pipelineId = "";
  const dealIds: string[] = [];
  const dealNames: string[] = [];

  afterAll(async () => {
    const sa = await superAdmin();
    const problems: string[] = [];
    for (const id of projectIds) {
      const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
      if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
        problems.push(`add member ${id}: ${added.status}`);
      }
      const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
        problems.push(`change leader ${id}: ${led.status}`);
      }
      const archived = await sa.c.post(`/api/projects/${id}/archive`);
      if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status} ${JSON.stringify(archived.json)}`);
    }
    // Pam's D2: the ZZ-TEST organisation this file creates is archived through the API.
    if (organisationId) {
      const archived = await sa.c.post(`/api/orgs/${organisationId}/archive`, { archive: true });
      if (archived.status !== 200) problems.push(`archive organisation ${organisationId}: ${archived.status} ${JSON.stringify(archived.json)}`);
    }
    for (const who of people) {
      if (who.id === sa.id) continue;
      const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
        problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("qa:TC missing seeds a shared deal and a shared project", async () => {
    const sa = await superAdmin();
    member = await zzAccount("member");
    adminUser = await zzAccount("admin");
    outsider = await zzAccount("outsider");
    expect((await sa.c.patch(`/api/team/${adminUser.id}`, { orgRole: "ADMIN" })).status).toBe(200);

    const pipes = await sa.c.get("/api/deals/pipelines");
    expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
    const pipe = (pipes.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    pipelineId = pipe!.id;
    const org = await sa.c.post("/api/orgs", { name: `ZZ-TEST Buyer ${RUN}` });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    organisationId = org.json.organisation.id as string;
    // Member A is an editor. The admin leads the deal, so GET /api/team/<adminId> lists it.
    const made = await sa.c.post("/api/deals", {
      name: DEAL_NAME,
      organisationId: org.json.organisation.id,
      pipelineId: pipe!.id,
      leaderId: adminUser.id,
      whyPursue: "ZZ-TEST fit",
      nextStep: { title: TASK_TITLE, dueDate: istDate(3) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    dealId = made.json.deal.id as string;
    projectIds.push(dealId);
    dealIds.push(dealId);
    dealNames.push(DEAL_NAME);
    expect((await sa.c.post(`/api/projects/${dealId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
    const stage = made.json.deal.stage?.name ?? made.json.deal.stageName;
    stageName = typeof stage === "string" ? stage : "Lead";

    plainName = `ZZ-TEST Shared ${RUN}`;
    const madePlain = await sa.c.post("/api/projects", { name: plainName, leaderId: adminUser.id });
    expect(madePlain.status, JSON.stringify(madePlain.json)).toBe(201);
    plainId = madePlain.json.project.id as string;
    projectIds.push(plainId);
    expect((await adminUser.c.post(`/api/projects/${plainId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
    expect((await adminUser.c.post(`/api/projects/${plainId}/members`, { userId: outsider.id, role: "EDITOR" })).status).toBe(201);
    await task(adminUser, plainId, { dueDate: "2031-03-20", title: `ZZ-TEST Shared task ${RUN}`, assigneeId: adminUser.id });
  });

  function body(person: unknown) {
    return JSON.stringify(person);
  }

  function assertHidden(person: { projects: { id?: string; name: string; href?: string | null; role?: string; openTasks?: number }[] }) {
    const text = body(person);
    for (const name of dealNames) expect(text).not.toContain(name);
    for (const id of dealIds) {
      expect(text).not.toContain(id);
      expect(text).not.toContain(`/projects/${id}`);
    }
    expect(text).not.toContain(TASK_TITLE);
    if (stageName) expect(text).not.toContain(stageName);
    expect(person.projects.filter((p) => p.href === null)).toEqual([{ name: HIDDEN_DEAL_LABEL, href: null }]);
    expect(person.projects.filter((p) => p.name === HIDDEN_DEAL_LABEL)).toHaveLength(1);
    expect(person.projects).toContainEqual(expect.objectContaining({ id: plainId, name: plainName }));
  }

  async function addHiddenDeal(name: string) {
    const sa = await superAdmin();
    const made = await sa.c.post("/api/deals", {
      name,
      organisationId,
      pipelineId,
      leaderId: adminUser.id,
      whyPursue: "ZZ-TEST fit",
      nextStep: { title: `${name} step`, dueDate: istDate(3) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const id = made.json.deal.id as string;
    projectIds.push(id);
    dealIds.push(id);
    dealNames.push(name);
    // The member shares every added deal. A deal they are not on would never be a row, so it cannot prove the count stays hidden.
    expect((await sa.c.post(`/api/projects/${id}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
  }

  // Member path: the membership query. Mutation check: on main today this is the deal id and name.
  it("qa:TC-APL2728-972a2619@v1 AC1: member path, admins: an editor's GET /api/team/<adminId> has no deal name or id", async () => {
    expect(dealId).toBeTruthy();
    const person = await withMode("admins", () => getPerson(actor(member, "MEMBER"), adminUser.id));
    expect(crmMode()).toBe("all");
    assertHidden(person);
    expect(person).toEqual({
      id: adminUser.id,
      name: adminUser.name,
      projects: [
        { id: plainId, name: plainName },
        { name: HIDDEN_DEAL_LABEL, href: null },
      ],
    });
    const outsiderView = await withMode("admins", () => getPerson(actor(outsider, "MEMBER"), adminUser.id));
    expect(body(outsiderView)).not.toContain(DEAL_NAME);
    expect(body(outsiderView)).not.toContain(dealId);
    expect(body(outsiderView)).not.toContain(HIDDEN_DEAL_LABEL);
    expect(outsiderView.projects).toEqual([{ id: plainId, name: plainName }]);
  });

  it("qa:TC-APL2728-972a2619@v1 AC1: member path, off: an editor's GET /api/team/<adminId> has no deal name or id", async () => {
    const person = await withMode("off", () => getPerson(actor(member, "MEMBER"), adminUser.id));
    assertHidden(person);
    expect(person).not.toHaveProperty("openTasks");
    expect(person).not.toHaveProperty("email");
  });

  it("qa:TC-APL2728-972a2619@v1 AC1: admin path, off: the admin return hides the deal and drops its open-task count", async () => {
    const person = await withMode("off", () => getPerson(actor(adminUser, "ADMIN"), adminUser.id));
    assertHidden(person);
    expect(person.openTasks).toBe(1);
    const plain = person.projects.find((p) => "id" in p && p.id === plainId);
    expect(plain).toMatchObject({ id: plainId, name: plainName, role: "LEADER", openTasks: 1 });
    expect(person.projects.find((p) => "id" in p && p.id === dealId)).toBeUndefined();
  });

  it("qa:TC-APL2728-dc394066@v1 AC2: admin path, admins: an admin still sees the deal, identical to all mode", async () => {
    const asAdmins = await withMode("admins", () => getPerson(actor(adminUser, "ADMIN"), adminUser.id));
    const asAll = await withMode("all", () => getPerson(actor(adminUser, "ADMIN"), adminUser.id));
    expect(asAdmins).toEqual(asAll);
    expect(body(asAdmins)).toContain(DEAL_NAME);
    expect(body(asAdmins)).toContain(dealId);
    expect(asAdmins.projects).toContainEqual(expect.objectContaining({ id: dealId, name: DEAL_NAME, role: "LEADER", openTasks: 1 }));
    expect(asAdmins.openTasks).toBe(2);
    expect(asAdmins.email).toBe(adminUser.email);
  });

  it("qa:TC-APL2728-85ead00c@v1 qa:TC-APL2728-13fdec48@v1 AC3: member and admin both see the deal on GET /api/team/<adminId> under all", async () => {
    const memberView = await withMode("all", () => getPerson(actor(member, "MEMBER"), adminUser.id));
    const adminView = await withMode("all", () => getPerson(actor(adminUser, "ADMIN"), adminUser.id));
    expect(memberView).toEqual({
      id: adminUser.id,
      name: adminUser.name,
      projects: [
        { id: dealId, name: DEAL_NAME },
        { id: plainId, name: plainName },
      ],
    });
    expect(body(memberView)).not.toContain(HIDDEN_DEAL_LABEL);
    expect(adminView.projects).toContainEqual(expect.objectContaining({ id: dealId, name: DEAL_NAME }));
    expect(adminView.openTasks).toBe(2);
  });

  // The AC names an admin opening a non-admin's page. The rep has one plain task and one deal task.
  it("qa:TC missing admin path, off: an admin viewing a non-admin rep hides that rep's deal", async () => {
    await task(adminUser, plainId, { dueDate: "2031-03-20", title: `ZZ-TEST Rep plain ${RUN}`, assigneeId: member.id });
    await task(adminUser, dealId, { dueDate: "2031-03-20", title: `ZZ-TEST Rep deal ${RUN}`, assigneeId: member.id });
    const person = await withMode("off", () => getPerson(actor(adminUser, "ADMIN"), member.id));
    expect(person.id).toBe(member.id);
    expect(person.email).toBe(member.email);
    expect(person.orgRole).toBe("MEMBER");
    assertHidden(person);
    expect(person.openTasks).toBe(1);
    expect(body(person)).not.toContain(`ZZ-TEST Rep deal ${RUN}`);
    const plain = person.projects.find((p) => "id" in p && p.id === plainId);
    expect(plain).toMatchObject({ id: plainId, name: plainName, role: "EDITOR", openTasks: 1 });
    expect(person.projects.filter((p) => "href" in p && p.href === null)).toEqual([{ name: HIDDEN_DEAL_LABEL, href: null }]);
  });

  // Mutation check: one row per hidden deal makes 1, 2 and 5 differ. The deal name fails assertHidden.
  it("qa:TC-APL2728-972a2619@v1 AC1: 1, 2 and 5 hidden deals are one sentence under admins and off, and 0 is none", async () => {
    const memberView = (mode: "admins" | "off") => withMode(mode, () => getPerson(actor(member, "MEMBER"), adminUser.id));
    const adminOff = () => withMode("off", () => getPerson(actor(adminUser, "ADMIN"), adminUser.id));
    const repOff = () => withMode("off", () => getPerson(actor(adminUser, "ADMIN"), member.id));
    const one = {
      admins: await memberView("admins"),
      off: await memberView("off"),
      adminOff: await adminOff(),
      repOff: await repOff(),
    };
    assertHidden(one.admins);
    assertHidden(one.off);
    assertHidden(one.adminOff);
    assertHidden(one.repOff);
    const sentences = (projects: unknown) => JSON.stringify(projects).split(HIDDEN_DEAL_LABEL).length - 1;
    expect(sentences(one.admins.projects)).toBe(1);
    expect(sentences(one.off.projects)).toBe(1);
    expect(sentences(one.adminOff.projects)).toBe(1);
    expect(sentences(one.repOff.projects)).toBe(1);
    expect(one.off.projects).toEqual(one.admins.projects);
    expect(one.adminOff.openTasks).toBe(1);
    expect(one.repOff.id).toBe(member.id);
    expect(one.repOff.openTasks).toBe(1);

    await addHiddenDeal(`ZZ-TEST Acme renewal 2 ${RUN}`);
    expect(await memberView("admins")).toEqual(one.admins);
    expect(await memberView("off")).toEqual(one.off);
    expect(await adminOff()).toEqual(one.adminOff);
    expect(await repOff()).toEqual(one.repOff);

    await addHiddenDeal(`ZZ-TEST Acme renewal 3 ${RUN}`);
    await addHiddenDeal(`ZZ-TEST Acme renewal 4 ${RUN}`);
    await addHiddenDeal(`ZZ-TEST Acme renewal 5 ${RUN}`);
    expect(await memberView("admins")).toEqual(one.admins);
    expect(await memberView("off")).toEqual(one.off);
    const fiveOff = await adminOff();
    expect(fiveOff).toEqual(one.adminOff);
    expect(fiveOff.projects.filter((p) => "href" in p && p.href === null)).toHaveLength(1);
    const fiveRep = await repOff();
    expect(fiveRep).toEqual(one.repOff);
    expect(fiveRep.projects.filter((p) => "href" in p && p.href === null)).toHaveLength(1);

    for (const mode of ["admins", "off"] as const) {
      const memberZero = await withMode(mode, () => getPerson(actor(member, "MEMBER"), outsider.id));
      const adminZero = await withMode(mode, () => getPerson(actor(adminUser, "ADMIN"), outsider.id));
      expect(body(memberZero)).not.toContain(HIDDEN_DEAL_LABEL);
      expect(body(adminZero)).not.toContain(HIDDEN_DEAL_LABEL);
      expect(memberZero.projects).toEqual([{ id: plainId, name: plainName }]);
      expect(adminZero.projects.some((p) => "href" in p && p.href === null)).toBe(false);
      expect(adminZero.projects.some((p) => "id" in p && p.id === dealId)).toBe(false);
    }
  });

  it("qa:TC missing load: 48 concurrent hidden person reads stay redacted", async () => {
    const started = Date.now();
    const results = await withMode("admins", () => Promise.all(Array.from({ length: 48 }, () => getPerson(actor(member, "MEMBER"), adminUser.id))));
    const ms = Date.now() - started;
    expect(results).toHaveLength(48);
    for (const person of results) assertHidden(person);
    expect(ms).toBeLessThan(30_000);
    console.log(`APL-2728 load: 48 concurrent getPerson (CRM_VISIBLE=admins, member) in ${ms}ms`);
  }, 60_000);
});
