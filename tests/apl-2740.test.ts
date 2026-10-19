// APL-2740. getPerson must not return CRM data to someone CRM_VISIBLE hides it from.
// These call getPerson and GET /api/team/[id] in this process and flip CRM_VISIBLE here.
// crmMode() reads it at call time. Seeding uses the app, which must be running with the CRM visible (the default).
// Names are ZZ-TEST. Addresses are nakul17+ aliases. qa:TC missing: no TC id has been assigned.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPerson } from "@/lib/team";
import { account, istDate, superAdmin, task, type Account } from "./helpers";

const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const [k, v] = jar.cookie.split("=");
      return k === name ? { name, value: v } : undefined;
    },
  }),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

const { GET } = await import("../src/app/api/team/[id]/route");

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const SPEND = "88001420.42";
const dealName = `ZZ-TEST Deal ${RUN}`;
const orgName = `ZZ-TEST Account ${RUN}`;
const plainName = `ZZ-TEST Shared ${RUN}`;
const stepTitle = `ZZ-TEST step ${RUN}`;
const whyPursue = `ZZ-TEST pursue ${RUN}`;

type Person = {
  id: string;
  name: string;
  projects: { id: string; name: string; role?: string; openTasks?: number }[];
  email?: string;
  orgRole?: string;
  openTasks?: number;
};

const world: {
  sa?: Account;
  member?: Account;
  leader?: Account;
  dealId: string;
  orgId: string;
  plainId: string;
  projectIds: string[];
  people: Account[];
} = { dealId: "", orgId: "", plainId: "", projectIds: [], people: [] };

const needles = () => [dealName, world.dealId, orgName, world.orgId, stepTitle, whyPursue, SPEND, "Proactive"];

function assertNoCrm(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const needle of needles()) expect(text, needle).not.toContain(needle);
  const banned = ["deals", "accounts", "spend", "value", "currency", "organisation", "organization", "pipeline", "stage"];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        expect(banned, key).not.toContain(key);
        walk(child);
      }
    }
  };
  walk(payload);
  expect(text).not.toContain("/deals/");
  expect(text).not.toContain("/accounts/");
  expect(text).not.toContain(`/projects/${world.dealId}`);
}

async function withMode<T>(mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CRM_VISIBLE;
  if (mode === undefined) delete process.env.CRM_VISIBLE;
  else process.env.CRM_VISIBLE = mode;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = prev;
  }
}

async function personRoute(who: Account, id: string) {
  jar.cookie = who.c.cookie;
  const res = await GET(new Request(`http://127.0.0.1/api/team/${id}`), { params: Promise.resolve({ id }) });
  const text = await res.text();
  const json = text ? JSON.parse(text) as { person?: Person; error?: string } : {};
  return { status: res.status, text, json };
}

const actor = (who: Account, orgRole: "MEMBER" | "ADMIN") => ({ id: who.id, orgRole });

describe("qa:TC missing APL-2740 getPerson respects CRM_VISIBLE", () => {
  beforeAll(async () => {
    const sa = await superAdmin();
    const member = await account(`ZZ-TEST member ${RUN}`, `nakul17+zz-2740-${RUN}-m@aplyd.com`);
    const leader = await account(`ZZ-TEST admin ${RUN}`, `nakul17+zz-2740-${RUN}-a@aplyd.com`);
    world.sa = sa;
    world.member = member;
    world.leader = leader;
    world.people.push(member, leader);
    expect((await sa.c.patch(`/api/team/${leader.id}`, { orgRole: "ADMIN" })).status).toBe(200);

    const pipes = await sa.c.get("/api/deals/pipelines");
    expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
    const pipe = (pipes.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    const org = await sa.c.post("/api/orgs", { name: orgName });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    world.orgId = org.json.organisation.id as string;
    const made = await sa.c.post("/api/deals", {
      name: dealName,
      organisationId: world.orgId,
      pipelineId: pipe!.id,
      leaderId: leader.id,
      whyPursue,
      value: Number(SPEND),
      currency: "USD",
      nextStep: { title: stepTitle, dueDate: istDate(3) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    world.dealId = made.json.deal.id as string;
    world.projectIds.push(world.dealId);
    expect((await sa.c.post(`/api/projects/${world.dealId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);

    const plain = await sa.c.post("/api/projects", { name: plainName, leaderId: leader.id });
    expect(plain.status, JSON.stringify(plain.json)).toBe(201);
    world.plainId = plain.json.project.id as string;
    world.projectIds.push(world.plainId);
    expect((await leader.c.post(`/api/projects/${world.plainId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
    await task(leader, world.plainId, { title: `ZZ-TEST shared task ${RUN}`, assigneeId: leader.id });
  }, 60_000);

  afterAll(async () => {
    const sa = world.sa ?? await superAdmin();
    const problems: string[] = [];
    for (const id of world.projectIds) {
      const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
      if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
        problems.push(`add member ${id}: ${added.status}`);
      }
      const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
        problems.push(`change leader ${id}: ${led.status}`);
      }
      const archived = await sa.c.post(`/api/projects/${id}/archive`);
      if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status}`);
    }
    for (const who of world.people) {
      const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
        problems.push(`deactivate ${who.email}: ${off.status}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("qa:TC missing AC1 getPerson is only called from the team person route", () => {
    const src = path.join(process.cwd(), "src");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
        if (readFileSync(full, "utf8").includes("getPerson(")) found.push(path.relative(src, full).split(path.sep).join("/"));
      }
    };
    walk(src);
    expect(found.sort()).toEqual(["app/api/team/[id]/route.ts", "lib/team.ts"]);
  });

  it("qa:TC missing AC1 a non-admin getPerson response has no deal, account, deal name or spend", async () => {
    const member = world.member!;
    const leader = world.leader!;
    for (const mode of ["admins", "off"] as const) {
      for (const target of [leader, member]) {
        const person = await withMode(mode, () => getPerson(actor(member, "MEMBER"), target.id));
        assertNoCrm(person);
        expect(person).toEqual({
          id: target.id,
          name: target.name,
          projects: [{ id: world.plainId, name: plainName }],
        });
        expect(person).not.toHaveProperty("email");
        expect(person).not.toHaveProperty("openTasks");
      }
    }
    // Under off the CRM is hidden from Admins too, so the admin branch must drop the deal and its open task.
    const hiddenAdmin = await withMode("off", () => getPerson(actor(leader, "ADMIN"), leader.id));
    assertNoCrm(hiddenAdmin);
    expect(hiddenAdmin.projects.map((p) => p.id)).toEqual([world.plainId]);
    expect(hiddenAdmin.openTasks).toBe(1);
    expect(hiddenAdmin.projects[0]).toMatchObject({ id: world.plainId, name: plainName, role: "LEADER", openTasks: 1 });
  });

  it("qa:TC missing AC1 GET /api/team/[id] hides CRM fields from a non-admin", async () => {
    const member = world.member!;
    const leader = world.leader!;
    for (const target of [leader, member]) {
      const res = await withMode("admins", () => personRoute(member, target.id));
      expect(res.status).toBe(200);
      assertNoCrm(res.json);
      assertNoCrm(res.text);
      expect(res.json.person).toEqual({
        id: target.id,
        name: target.name,
        projects: [{ id: world.plainId, name: plainName }],
      });
    }
    const off = await withMode("off", () => personRoute(leader, leader.id));
    expect(off.status).toBe(200);
    assertNoCrm(off.json);
    expect(off.json.person?.projects.map((p) => p.id)).toEqual([world.plainId]);
    expect(off.json.person?.openTasks).toBe(1);
  });

  it("qa:TC missing AC2 an admin getPerson response still includes the deal", async () => {
    const leader = world.leader!;
    const asAll = await withMode("all", () => getPerson(actor(leader, "ADMIN"), leader.id));
    const asUnset = await withMode(undefined, () => getPerson(actor(leader, "ADMIN"), leader.id));
    const asAdmins = await withMode("admins", () => getPerson(actor(leader, "ADMIN"), leader.id));
    expect(asUnset).toEqual(asAll);
    expect(asAdmins).toEqual(asAll);
    expect(JSON.stringify(asAdmins)).toContain(dealName);
    expect(JSON.stringify(asAdmins)).toContain(world.dealId);
    expect(asAdmins.projects).toContainEqual(expect.objectContaining({ id: world.dealId, name: dealName, role: "LEADER", openTasks: 1 }));
    expect(asAdmins.projects).toContainEqual(expect.objectContaining({ id: world.plainId, name: plainName, role: "LEADER", openTasks: 1 }));
    expect(asAdmins.openTasks).toBe(2);
    const memberAll = await withMode("all", () => getPerson(actor(world.member!, "MEMBER"), leader.id));
    expect(memberAll.projects.map((p) => p.name).sort()).toEqual([dealName, plainName].sort());
  });

  it("qa:TC missing AC2 GET /api/team/[id] still returns the deal to an admin", async () => {
    const leader = world.leader!;
    const asAll = await withMode("all", () => personRoute(leader, leader.id));
    const asAdmins = await withMode("admins", () => personRoute(leader, leader.id));
    expect(asAll.status).toBe(200);
    expect(asAdmins.status).toBe(200);
    expect(asAdmins.json).toEqual(asAll.json);
    expect(asAdmins.text).toContain(dealName);
    expect(asAdmins.text).toContain(world.dealId);
    expect(asAdmins.json.person?.projects).toContainEqual(expect.objectContaining({ id: world.dealId, name: dealName, role: "LEADER", openTasks: 1 }));
    expect(asAdmins.json.person?.openTasks).toBe(2);
  });
});
