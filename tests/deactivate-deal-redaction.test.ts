// APL-2735. POST /api/team/:id/deactivate must not name a deal the caller cannot see.
// These call deactivate in this process and flip CRM_VISIBLE; crmMode() reads it at call time.
// Setup uses the live server. Names are ZZ-TEST. Addresses are nakul17+ aliases.
import { afterAll, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/http";
import { db } from "@/lib/db";
import { deactivate } from "@/lib/team";
import { account, superAdmin, type Account } from "./helpers";
import { cleanupHiddenProject, hiddenDeal, hiddenProjectFixture, withCrmMode, type HiddenDealFixture } from "./hidden-project";

const GENERIC = "Name a new Leader first.";
const FORBIDDEN = "You cannot deactivate this person.";
const MODES = ["on", "all", "admins", "off"] as const;
type Mode = (typeof MODES)[number];
type Role = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];
const fixtures: HiddenDealFixture[] = [];

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
  let spareLeader: Account;
  const dealNames = [`ZZ-TEST Northwind ${RUN}`, `ZZ-TEST Contoso ${RUN}`];
  const dealIds: string[] = [];
  let mixedDealName = "";
  let mixedDealId = "";
  let mixedProjectName = "";
  let mixedProjectId = "";
  let plainName = "";
  let plainId = "";

  afterAll(async () => {
    await cleanupHiddenProject(fixtures, people);
  });

  it("qa:TC missing AC3: seeds two deals, a plain project, and a mixed leadership", async () => {
    const sa = await superAdmin();
    adminUser = await zzAccount("admin");
    member = await zzAccount("member");
    dealLeader = await zzAccount("deal leader");
    projectLeader = await zzAccount("project leader");
    mixedLeader = await zzAccount("mixed leader");
    spareLeader = await zzAccount("spare leader");
    expect((await sa.c.patch(`/api/team/${adminUser.id}`, { orgRole: "ADMIN" })).status).toBe(200);

    // Two deals for one Leader, the plain project for another, and a mixed leadership.
    const first = await hiddenDeal(sa, { leader: dealLeader, label: `Northwind ${RUN}` });
    const second = await hiddenDeal(sa, { leader: dealLeader, label: `Contoso ${RUN}`, organisationId: first.organisationId, pipelineId: first.pipelineId });
    const plainFixture = await hiddenProjectFixture(sa, { leader: spareLeader, plainLeader: projectLeader, label: `Plain ${RUN}`, organisationId: first.organisationId, pipelineId: first.pipelineId });
    const mixed = await hiddenProjectFixture(sa, { leader: mixedLeader, label: `Mixed ${RUN}`, organisationId: first.organisationId, pipelineId: first.pipelineId });
    fixtures.push(first, second, plainFixture, mixed);

    dealIds.push(first.deal.id, second.deal.id);
    dealNames.splice(0, dealNames.length, first.deal.name, second.deal.name);
    plainName = plainFixture.plain.name;
    plainId = plainFixture.plain.id;
    mixedDealName = mixed.deal.name;
    mixedDealId = mixed.deal.id;
    mixedProjectName = mixed.plain.name;
    mixedProjectId = mixed.plain.id;
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
        const res = await withCrmMode(mode, () => attempt(caller.who, caller.role, dealLeader.id));
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
    const asSuper = await withCrmMode("off", () => attempt(sa, "SUPER_ADMIN", dealLeader.id));
    expect(asSuper.status).toBe(409);
    expect(asSuper.body).toEqual({ error: GENERIC });
    assertNoDeal(asSuper.text, dealNames, dealIds);
    expect((await db.user.findUnique({ where: { id: dealLeader.id }, select: { deactivatedAt: true } }))?.deactivatedAt).toBeNull();
  });

  it("qa:TC missing AC1: still names a plain project when the CRM is off", async () => {
    const res = await withCrmMode("off", () => attempt(adminUser, "ADMIN", projectLeader.id));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: `Name a new Leader first for: ${plainName}`,
      leads: [{ id: plainId, name: plainName }],
    });
  });

  it("qa:TC missing AC1 AC2: names the visible project and omits the hidden deal", async () => {
    const hidden = await withCrmMode("off", () => attempt(adminUser, "ADMIN", mixedLeader.id));
    expect(hidden.status).toBe(409);
    expect(hidden.body).toEqual({
      error: `Name a new Leader first for: ${mixedProjectName}`,
      leads: [{ id: mixedProjectId, name: mixedProjectName }],
    });
    assertNoDeal(hidden.text, [mixedDealName], [mixedDealId]);
    expect(hidden.text).not.toMatch(/\b2\b/);

    const shown = await withCrmMode("all", () => attempt(adminUser, "ADMIN", mixedLeader.id));
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
