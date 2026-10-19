// APL-2735. POST /api/team/:id/deactivate must not name a deal the caller cannot see.
// These call deactivate in this process and flip CRM_VISIBLE; crmMode() reads it at call time.
// Setup uses the live server. Names are ZZ-TEST. Addresses are nakul17+ aliases.
import { afterAll, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/http";
import { db } from "@/lib/db";
import { deactivate } from "@/lib/team";
import { account, istDate, superAdmin, type Account } from "./helpers";

const GENERIC = "Name a new Leader first.";
const FORBIDDEN = "You cannot deactivate this person.";
const MODES = ["on", "all", "admins", "off"] as const;
type Mode = (typeof MODES)[number];
type Role = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];
const projectIds: string[] = [];

async function withMode<T>(mode: Mode, fn: () => Promise<T>): Promise<T> {
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
  const email = `nakul17+zz-2735-${RUN}-${slug}-${n}@aplyd.com`;
  const who = await account(`ZZ-TEST ${role} ${RUN}-${n}`, email);
  people.push(who);
  return who;
}

/** The JSON body handle() would send for this call. A 200 means the person was deactivated. */
async function attempt(who: Account, orgRole: Role, targetId: string) {
  try {
    const result = await deactivate({ id: who.id, orgRole }, targetId, "leaders");
    return { status: 200, body: result as unknown, text: JSON.stringify(result) };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const body = { error: err.message, ...err.extra };
    return { status: err.status, body, text: JSON.stringify(body) };
  }
}

function assertNoDeal(text: string, dealNames: string[], dealIds: string[]) {
  for (const name of dealNames) expect(text).not.toContain(name);
  for (const id of dealIds) expect(text).not.toContain(id);
}

describe("qa:TC missing APL-2735 deactivate 409 hides deals the caller cannot see", () => {
  let adminUser: Account;
  let member: Account;
  let dealLeader: Account;
  let projectLeader: Account;
  let mixedLeader: Account;
  const dealNames = [`ZZ-TEST Northwind ${RUN}`, `ZZ-TEST Contoso ${RUN}`];
  const dealIds: string[] = [];
  let mixedDealName = "";
  let mixedDealId = "";
  let mixedProjectName = "";
  let mixedProjectId = "";
  let plainName = "";
  let plainId = "";

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
    for (const who of people) {
      if (who.id === sa.id) continue;
      const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
        problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("qa:TC missing AC3: seeds two deals, a plain project, and a mixed leadership", async () => {
    const sa = await superAdmin();
    adminUser = await zzAccount("admin");
    member = await zzAccount("member");
    dealLeader = await zzAccount("deal leader");
    projectLeader = await zzAccount("project leader");
    mixedLeader = await zzAccount("mixed leader");
    expect((await sa.c.patch(`/api/team/${adminUser.id}`, { orgRole: "ADMIN" })).status).toBe(200);

    const pipes = await sa.c.get("/api/deals/pipelines");
    expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
    const pipe = (pipes.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    const org = await sa.c.post("/api/orgs", { name: `ZZ-TEST Buyer ${RUN}` });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    const organisationId = org.json.organisation.id as string;

    for (const name of dealNames) {
      const made = await sa.c.post("/api/deals", {
        name,
        organisationId,
        pipelineId: pipe!.id,
        leaderId: dealLeader.id,
        whyPursue: "ZZ-TEST fit",
        nextStep: { title: `ZZ-TEST step ${RUN}`, dueDate: istDate(3) },
      });
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      dealIds.push(made.json.deal.id as string);
      projectIds.push(made.json.deal.id as string);
    }
    expect(dealIds).toHaveLength(2);

    plainName = `ZZ-TEST Plain ${RUN}`;
    const plain = await sa.c.post("/api/projects", { name: plainName, leaderId: projectLeader.id });
    expect(plain.status, JSON.stringify(plain.json)).toBe(201);
    plainId = plain.json.project.id as string;
    projectIds.push(plainId);

    mixedDealName = `ZZ-TEST Mixed deal ${RUN}`;
    mixedProjectName = `ZZ-TEST Mixed project ${RUN}`;
    const mixedDeal = await sa.c.post("/api/deals", {
      name: mixedDealName,
      organisationId,
      pipelineId: pipe!.id,
      leaderId: mixedLeader.id,
      whyPursue: "ZZ-TEST fit",
      nextStep: { title: `ZZ-TEST mixed step ${RUN}`, dueDate: istDate(4) },
    });
    expect(mixedDeal.status, JSON.stringify(mixedDeal.json)).toBe(201);
    mixedDealId = mixedDeal.json.deal.id as string;
    projectIds.push(mixedDealId);
    const mixedProject = await sa.c.post("/api/projects", { name: mixedProjectName, leaderId: mixedLeader.id });
    expect(mixedProject.status, JSON.stringify(mixedProject.json)).toBe(201);
    mixedProjectId = mixedProject.json.project.id as string;
    projectIds.push(mixedProjectId);
  });

  // on and all: everyone can see the CRM. admins: only an admin can. off: nobody can.
  // A member is not allowed to deactivate, so the answer is 403 before any leader list is built.
  function kind(mode: Mode, role: Role): "detail" | "generic" | "forbidden" {
    if (role === "MEMBER") return "forbidden";
    if (mode === "off") return "generic";
    return "detail";
  }

  it("qa:TC missing AC1 AC2: covers on, all, admins and off for an admin and a member", async () => {
    expect(dealIds).toHaveLength(2);
    const callers: { who: Account; role: Role }[] = [
      { who: adminUser, role: "ADMIN" },
      { who: member, role: "MEMBER" },
    ];
    for (const mode of MODES) {
      for (const caller of callers) {
        const res = await withMode(mode, () => attempt(caller.who, caller.role, dealLeader.id));
        const label = `CRM_VISIBLE=${mode} ${caller.role} ${res.text}`;
        const expected = kind(mode, caller.role);
        if (expected === "detail") {
          expect(res.status, label).toBe(409);
          const body = res.body as { error: string; leads: { id: string; name: string }[] };
          expect(body.error).toBe("Name a new Leader first for: " + body.leads.map((row) => row.name).join(", "));
          expect(body.leads).toHaveLength(2);
          expect(body.leads).toEqual(expect.arrayContaining(dealIds.map((id, i) => ({ id, name: dealNames[i] }))));
        } else if (expected === "generic") {
          expect(res.status, label).toBe(409);
          expect(res.body).toEqual({ error: GENERIC });
          expect(res.text).not.toMatch(/\b2\b/);
          assertNoDeal(res.text, dealNames, dealIds);
        } else {
          expect(res.status, label).toBe(403);
          expect(res.body).toEqual({ error: FORBIDDEN });
          assertNoDeal(res.text, dealNames, dealIds);
        }
      }
    }
    // Anyone under off, including the Super Admin, gets the generic 409.
    const sa = await superAdmin();
    const asSuper = await withMode("off", () => attempt(sa, "SUPER_ADMIN", dealLeader.id));
    expect(asSuper.status).toBe(409);
    expect(asSuper.body).toEqual({ error: GENERIC });
    assertNoDeal(asSuper.text, dealNames, dealIds);
    expect((await db.user.findUnique({ where: { id: dealLeader.id }, select: { deactivatedAt: true } }))?.deactivatedAt).toBeNull();
  });

  it("qa:TC missing AC1: still names a plain project when the CRM is off", async () => {
    const res = await withMode("off", () => attempt(adminUser, "ADMIN", projectLeader.id));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: `Name a new Leader first for: ${plainName}`,
      leads: [{ id: plainId, name: plainName }],
    });
  });

  it("qa:TC missing AC1 AC2: names the visible project and omits the hidden deal", async () => {
    const hidden = await withMode("off", () => attempt(adminUser, "ADMIN", mixedLeader.id));
    expect(hidden.status).toBe(409);
    expect(hidden.body).toEqual({
      error: `Name a new Leader first for: ${mixedProjectName}`,
      leads: [{ id: mixedProjectId, name: mixedProjectName }],
    });
    assertNoDeal(hidden.text, [mixedDealName], [mixedDealId]);
    expect(hidden.text).not.toMatch(/\b2\b/);

    const shown = await withMode("all", () => attempt(adminUser, "ADMIN", mixedLeader.id));
    expect(shown.status).toBe(409);
    const body = shown.body as { error: string; leads: { id: string; name: string }[] };
    expect(body.error).toBe("Name a new Leader first for: " + body.leads.map((row) => row.name).join(", "));
    expect(body.leads).toEqual(expect.arrayContaining([
      { id: mixedDealId, name: mixedDealName },
      { id: mixedProjectId, name: mixedProjectName },
    ]));
    expect(body.leads).toHaveLength(2);
  });
});
