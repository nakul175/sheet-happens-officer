import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { account, admin, cleanupZz, istDate, superAdmin, task, type Account } from "./helpers";

const run = Date.now();
let seq = 0;
const projects: string[] = [];
const people: Account[] = [];

async function person(label: string) {
  const who = await account(`sho3052-${label}`);
  people.push(who);
  return who;
}

async function organisation(who: Account, label: string) {
  const r = await who.c.post("/api/orgs", { name: `ZZ-TEST SHO-3052 ${label} ${run}-${seq++}` });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { id: r.json.organisation.id as string, name: r.json.organisation.name as string };
}

async function deal(who: Account, buyerId: string, name = `ZZ-TEST SHO-3052 deal ${run}-${seq++}`, force = false) {
  const pipelines = (await who.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const pipelineId = pipelines.find((p) => p.key === "DEAL_PROACTIVE")!.id;
  const r = await who.c.post("/api/deals", {
    name, organisationId: buyerId, pipelineId, leaderId: who.id, whyPursue: "Buyer replacement acceptance",
    nextStep: { title: `ZZ-TEST SHO-3052 next ${seq++}`, dueDate: istDate(3) }, force,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  projects.push(id);
  return id;
}

async function buyer(who: Account, projectId: string) {
  const project = (await who.c.get(`/api/projects/${projectId}`)).json.project;
  return project.deal.parties.find((p: { role: string }) => p.role === "BUYER") as {
    id: string; role: string; organisation: { id: string; name: string };
  };
}

afterAll(async () => cleanupZz(projects, people));

describe("SHO-3052 controlled Buyer replacement", () => {
  it("atomically replaces only the Buyer and updates every read model with an audit receipt", async () => {
    const leader = await person("leader");
    const oldBuyer = await organisation(leader, "old buyer");
    const newBuyer = await organisation(leader, "new buyer");
    const partner = await organisation(leader, "partner");
    const projectId = await deal(leader, oldBuyer.id);
    expect((await leader.c.post(`/api/projects/${projectId}/parties`, { organisationId: partner.id, role: "PARTNER" })).status).toBe(201);
    const taskId = await task(leader, projectId, { title: `ZZ-TEST SHO-3052 preserved ${seq++}` });
    const before = (await leader.c.get(`/api/projects/${projectId}`)).json.project;
    const current = await buyer(leader, projectId);

    const changed = await leader.c.patch(`/api/projects/${projectId}/parties/buyer`, {
      organisationId: newBuyer.id,
      expectedPartyId: current.id,
      expectedOrganisationId: oldBuyer.id,
    });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    expect(changed.json).toMatchObject({ oldBuyer, newBuyer });

    const after = (await leader.c.get(`/api/projects/${projectId}`)).json.project;
    expect(after.deal.parties.filter((p: { role: string }) => p.role === "BUYER")).toEqual([
      expect.objectContaining({ id: current.id, organisation: newBuyer }),
    ]);
    expect(after.deal.parties).toContainEqual(expect.objectContaining({ role: "PARTNER", organisation: partner }));
    expect(after.members).toEqual(before.members);
    expect(after.sections.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })))
      .toEqual(before.sections.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })));
    expect((await leader.c.get(`/api/tasks/${taskId}`)).status).toBe(200);

    const oldDeals = (await leader.c.get(`/api/orgs/${oldBuyer.id}`)).json.organisation.deals as { projectId: string }[];
    const newDeals = (await leader.c.get(`/api/orgs/${newBuyer.id}`)).json.organisation.deals as { projectId: string; role: string }[];
    expect(oldDeals.some((d) => d.projectId === projectId)).toBe(false);
    expect(newDeals).toContainEqual(expect.objectContaining({ projectId, role: "BUYER" }));
    const board = (await leader.c.get("/api/deals")).json.deals as { id: string; organisation: { id: string } }[];
    expect(board.find((d) => d.id === projectId)?.organisation.id).toBe(newBuyer.id);

    const log = await db.actionLog.findFirstOrThrow({
      where: { projectId, targetId: projectId, actorId: leader.id, action: "deal.buyer_replaced" },
      orderBy: { createdAt: "desc" },
    });
    expect(log.beforeState).toEqual({ partyId: current.id, organisationId: oldBuyer.id, organisation: oldBuyer.name });
    expect(log.afterState).toEqual({ partyId: current.id, organisationId: newBuyer.id, organisation: newBuyer.name });
    const activity = (await leader.c.get(`/api/projects/${projectId}/activity`)).json.items as { what: string }[];
    expect(activity.some((x) => x.what.includes(`changed the Buyer from ${oldBuyer.name} to ${newBuyer.name}`))).toBe(true);
  });

  it("limits replacement to Leaders/Admins and keeps the old Buyer on invalid, stale and unconfirmed duplicate requests", async () => {
    const leader = await person("authority-leader");
    const editor = await person("authority-editor");
    const viewer = await person("authority-viewer");
    const oldBuyer = await organisation(leader, "authority old");
    const newBuyer = await organisation(leader, "authority new");
    const archived = await organisation(leader, "archived");
    const dealName = `ZZ-TEST SHO-3052 duplicate ${run}-${seq++}`;
    const projectId = await deal(leader, oldBuyer.id, dealName);
    await leader.c.post(`/api/projects/${projectId}/members`, { userId: editor.id, role: "EDITOR" });
    await leader.c.post(`/api/projects/${projectId}/members`, { userId: viewer.id, role: "VIEWER" });
    const current = await buyer(leader, projectId);
    const body = { organisationId: newBuyer.id, expectedPartyId: current.id, expectedOrganisationId: oldBuyer.id };

    expect((await editor.c.patch(`/api/projects/${projectId}/parties/buyer`, body)).status).toBe(403);
    expect((await viewer.c.patch(`/api/projects/${projectId}/parties/buyer`, body)).status).toBe(403);
    await leader.c.post(`/api/orgs/${archived.id}/archive`, { archive: true });
    expect((await leader.c.patch(`/api/projects/${projectId}/parties/buyer`, { ...body, organisationId: archived.id })).status).toBe(400);
    expect((await leader.c.patch(`/api/projects/${projectId}/parties/buyer`, { ...body, expectedPartyId: "stale-party" })).status).toBe(409);
    expect((await buyer(leader, projectId)).organisation.id).toBe(oldBuyer.id);

    await deal(leader, newBuyer.id, dealName, true);
    const warning = await leader.c.patch(`/api/projects/${projectId}/parties/buyer`, body);
    expect(warning.status).toBe(409);
    expect(warning.json.needsConfirm).toBe("duplicate");
    expect((await buyer(leader, projectId)).organisation.id).toBe(oldBuyer.id);
    expect((await leader.c.patch(`/api/projects/${projectId}/parties/buyer`, { ...body, force: true })).status).toBe(200);

    const sa = await superAdmin();
    const globalAdmin = await admin(sa, `sho3052-admin-${seq++}`);
    people.push(globalAdmin);
    const adminTarget = await organisation(leader, "admin target");
    const now = await buyer(leader, projectId);
    expect((await globalAdmin.c.patch(`/api/projects/${projectId}/parties/buyer`, {
      organisationId: adminTarget.id, expectedPartyId: now.id, expectedOrganisationId: now.organisation.id,
    })).status).toBe(200);
  });
});
