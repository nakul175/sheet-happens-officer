// Live HTTP + PostgreSQL acceptance. Every new fixture is synthetic and retired in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { convertToBid, moveStage, previewBidConversion } from "@/lib/deals";
import { dealsOfOrganisation } from "@/lib/orgs";
import { account, cleanupZz, istDate, superAdmin, type Account } from "./helpers";

const projects: string[] = [], people: Account[] = [], orgs: string[] = [], stages: string[] = [];
let leader: Account, editor: Account, viewer: Account, outsider: Account, sa: Account;
let proactive: { id: string; stages: { id: string; category: string }[] }, bid: typeof proactive;
const actor = (a: Account, orgRole: "MEMBER" | "SUPER_ADMIN" = "MEMBER") => ({ id: a.id, orgRole });
const url = (id: string) => `/api/projects/${id}/convert-to-bid`;
const fixtureName = (label: string) => `ZZ-TEST SHO-3053 ${label} ${Date.now()}-${projects.length}`;
async function fixture(label: string, options: { bid?: boolean; value?: number } = {}) {
  const org = await leader.c.post("/api/orgs", { name: fixtureName(`${label} buyer`) });
  expect(org.status).toBe(201); orgs.push(org.json.organisation.id);
  const r = await leader.c.post("/api/deals", { name: fixtureName(label), organisationId: org.json.organisation.id, pipelineId: options.bid ? bid.id : proactive.id, leaderId: leader.id, whyPursue: "Synthetic conversion acceptance", nextStep: { title: "ZZ-TEST first next step", dueDate: istDate(3) }, ...(options.bid ? { submissionDeadline: istDate(10) } : {}), ...(options.value ? { value: options.value, currency: "INR" } : {}) });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string; projects.push(id);
  for (const [a, role] of [[editor, "EDITOR"], [viewer, "VIEWER"]] as const) expect((await leader.c.post(`/api/projects/${id}/members`, { userId: a.id, role })).status).toBe(201);
  return id;
}
async function preview(id: string, who = leader) {
  const r = await who.c.get(url(id)); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json;
}
async function body(id: string, extra: Record<string, unknown> = {}) {
  const p = await preview(id);
  return { expectedRevision: p.revision, stageId: bid.stages[0].id, submissionDeadline: istDate(20), ...extra };
}
async function snapshot(id: string) {
  return JSON.parse(JSON.stringify(await db.project.findUniqueOrThrow({ where: { id }, include: { deal: true, members: { orderBy: { userId: "asc" } }, parties: { orderBy: { id: "asc" } }, tasks: { orderBy: { id: "asc" }, include: { comments: true } }, sections: { orderBy: { id: "asc" } }, notes: true, actionLogs: { orderBy: { id: "asc" } } } })));
}
async function customStage(requiredFields: string[], needsReason = false, category: "ACTIVE" | "PAUSED" = "ACTIVE") {
  const id = `zz-test-3053-${Date.now()}-${stages.length}`; stages.push(id);
  return db.stage.create({ data: { id, pipelineId: bid.id, name: `ZZ-TEST ${id}`, position: 90 + stages.length, category, requiredFields, needsReason } });
}
beforeAll(async () => {
  sa = await superAdmin();
  [leader, editor, viewer, outsider] = await Promise.all(["leader", "editor", "viewer", "outsider"].map((role) => account(`zz3053${role}`, undefined, `ZZ-TEST SHO-3053 ${role}`)));
  people.push(leader, editor, viewer, outsider);
  const p = await leader.c.get("/api/deals/pipelines"); expect(p.status).toBe(200);
  proactive = p.json.pipelines.find((x: { key: string }) => x.key === "DEAL_PROACTIVE"); bid = p.json.pipelines.find((x: { key: string }) => x.key === "DEAL_BID");
});
afterAll(async () => {
  // Test-only stages are detached from our own archived deals before deleting their configuration.
  for (const id of projects) {
    const p = await db.project.findUniqueOrThrow({ where: { id } });
    if (p.archivedAt) expect((await sa.c.post(`/api/projects/${id}/unarchive`)).status).toBe(200);
  }
  await cleanupZz(projects, people);
  for (const id of orgs) expect((await sa.c.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(200);
  for (const id of stages) {
    await db.project.updateMany({ where: { id: { in: projects }, stageId: id }, data: { stageId: bid.stages[0].id } });
    await db.stage.delete({ where: { id } });
  }
  await db.$disconnect();
}, 120_000);

describe("SHO-3053 one-way Proactive to Bid", () => {
  it("retains same ID, parties, value, ownership, tasks, notes, comments and history; updates all read models and audit without Undo", async () => {
    const id = await fixture("retain", { value: 125000 });
    const p = await db.project.findUniqueOrThrow({ where: { id }, include: { tasks: true, parties: true } });
    await db.note.create({ data: { workspaceId: p.workspaceId, organisationId: p.parties[0].organisationId, projectId: id, kind: "MEETING", date: new Date(), text: "ZZ-TEST retained note", authorId: leader.id } });
    await db.comment.create({ data: { taskId: p.tasks[0].id, authorId: leader.id, text: "ZZ-TEST retained comment" } });
    const partner = await leader.c.post("/api/orgs", { name: fixtureName("partner") }); expect(partner.status).toBe(201); orgs.push(partner.json.organisation.id);
    expect((await leader.c.post(`/api/projects/${id}/parties`, { organisationId: partner.json.organisation.id, role: "PARTNER" })).status).toBe(201);
    const before = await snapshot(id), b = await body(id);
    const oldList = await leader.c.get(`/api/deals?pipelineId=${proactive.id}`), newList = await leader.c.get(`/api/deals?pipelineId=${bid.id}`);
    const r = await editor.c.post(url(id), b); expect(r.status, JSON.stringify(r.json)).toBe(200); expect(r.json.deal.id).toBe(id); expect(r.headers.get("x-undo-id")).toBeNull();
    const after = await snapshot(id);
    for (const k of ["id", "name", "workspaceId", "members", "parties", "tasks", "sections", "notes"]) expect(after[k], k).toEqual(before[k]);
    for (const k of Object.keys(before.deal).filter((k) => k !== "submissionDeadline")) expect(after.deal[k], k).toEqual(before.deal[k]);
    expect(after.pipelineId).toBe(bid.id); expect(after.stageId).toBe(b.stageId); expect(after.stageChangedAt).not.toBe(before.stageChangedAt);
    expect(after.actionLogs.filter((x: { action: string }) => x.action !== "deal.pipeline_converted")).toEqual(before.actionLogs);
    const action = after.actionLogs.find((x: { action: string }) => x.action === "deal.pipeline_converted");
    expect(action.actorId).toBe(editor.id); expect(action.beforeState.pipelineId).toBe(proactive.id); expect(action.afterState.stageId).toBe(b.stageId);
    expect(await db.auditLog.count({ where: { targetId: id, event: "DEAL_PIPELINE_CONVERTED", actorId: editor.id } })).toBe(1);
    expect((await editor.c.post(`/api/actions/${action.id}/undo`)).status).toBe(409);
    const oldAfter = await leader.c.get(`/api/deals?pipelineId=${proactive.id}`), newAfter = await leader.c.get(`/api/deals?pipelineId=${bid.id}`);
    expect(oldAfter.json.deals).toHaveLength(oldList.json.deals.length - 1); expect(newAfter.json.deals).toHaveLength(newList.json.deals.length + 1);
    expect(newAfter.json.deals.find((x: { id: string }) => x.id === id).pipeline.id).toBe(bid.id);
    const page = await leader.c.get(`/api/projects/${id}`); expect(page.json.project.deal.pipeline.id).toBe(bid.id); expect(page.json.project.deal.stage.id).toBe(b.stageId);
    const accountDeals = await dealsOfOrganisation(actor(leader), p.parties[0].organisationId); expect(accountDeals.find((x) => x.projectId === id)?.pipeline).toBe("Bid");
    const feed = await leader.c.get(`/api/projects/${id}/activity`); expect(JSON.stringify(feed.json)).toContain("converted the deal from Proactive");
    expect((await leader.c.get(url(id))).status).toBe(409); expect((await leader.c.post(url(id), b)).status).toBe(409);
    expect((await leader.c.patch(`/api/projects/${id}/deal`, { expectedPipelineId: proactive.id, submissionDeadline: null })).status).toBe(409);
    expect((await leader.c.post(`/api/projects/${id}/stage`, { stageId: proactive.stages[0].id })).status).toBe(400);
  });
  it("denies Viewers and outsiders on preview and commit, and rechecks withdrawn membership", async () => {
    const id = await fixture("access"), b = await body(id), before = await snapshot(id);
    for (const [who, status] of [[viewer, 403], [outsider, 404]] as const) {
      expect((await who.c.get(url(id))).status).toBe(status); expect((await who.c.post(url(id), b)).status).toBe(status);
    }
    expect(await snapshot(id)).toEqual(before);
    expect((await leader.c.patch(`/api/projects/${id}/members/${editor.id}`, { role: "VIEWER" })).status).toBe(200);
    const revoked = await snapshot(id); expect((await editor.c.post(url(id), b)).status).toBe(403); expect(await snapshot(id)).toEqual(revoked);
  });
  it("allows existing Leader, Admin and Super Admin authority", async () => {
    const ad = await account("zz3053admin", undefined, "ZZ-TEST SHO-3053 Admin"); people.push(ad);
    expect((await sa.c.patch(`/api/team/${ad.id}`, { orgRole: "ADMIN" })).status).toBe(200);
    for (const who of [leader, ad, sa]) { const id = await fixture(`authority ${who.id}`); expect((await who.c.post(url(id), await body(id))).status).toBe(200); }
  });
  it("blocks archived, Won, Lost and already-Bid source deals without changes", async () => {
    for (const category of ["DONE", "LOST", "archived", "bid"]) {
      const id = await fixture(category, { bid: category === "bid" });
      if (category === "archived") expect((await leader.c.post(`/api/projects/${id}/archive`)).status).toBe(200);
      else if (category !== "bid") await db.project.update({ where: { id }, data: { stageId: proactive.stages.find((s) => s.category === category)!.id } });
      const before = await snapshot(id);
      expect((await leader.c.get(url(id))).status).toBe(409); expect((await leader.c.post(url(id), { expectedRevision: "0".repeat(64), stageId: bid.stages[0].id, submissionDeadline: istDate(10) })).status).toBe(409);
      expect(await snapshot(id)).toEqual(before);
    }
  });
  it("rejects absent, impossible or timestamp deadlines and implicit/terminal/wrong-pipeline mappings atomically", async () => {
    const id = await fixture("validation"), b = await body(id), before = await snapshot(id);
    const invalid = [{ submissionDeadline: undefined }, { submissionDeadline: "2026-02-31" }, { submissionDeadline: "2026-01-01T00:00:00Z" }, { stageId: undefined }, { stageId: "unknown" }, { stageId: proactive.stages[0].id }, ...bid.stages.filter((s) => ["DONE", "LOST"].includes(s.category)).map((s) => ({ stageId: s.id })), { expectedRevision: undefined }, { fields: { need: "unrelated overwrite" } }, { pipelineId: proactive.id }];
    for (const extra of invalid) { const r = await leader.c.post(url(id), { ...b, ...extra }); expect(r.status, JSON.stringify(extra)).toBe(400); expect(await snapshot(id)).toEqual(before); }
  });
  it("collects configured requirements and reason, blocks blanks and unknown fields, and accepts zero probability", async () => {
    const id = await fixture("requirements"), stage = await customStage(["need", "value", "probability", "expectedClose", "submissionDeadline"], true);
    const b = await body(id, { stageId: stage.id }); const before = await snapshot(id);
    for (const extra of [{}, { reason: "ZZ-TEST explicit mapping" }, { reason: "ZZ-TEST", fields: { need: "  ", value: 50, currency: "USD", probability: 0, expectedClose: istDate(25) } }, { reason: "ZZ-TEST", fields: { need: "fit", value: 50, probability: 0, expectedClose: istDate(25) } }]) {
      const r = await leader.c.post(url(id), { ...b, ...extra }); expect(r.status).toBeGreaterThanOrEqual(400); expect(await snapshot(id)).toEqual(before);
    }
    expect((await leader.c.post(url(id), { ...b, reason: "ZZ-TEST explicit mapping", fields: { need: " fit ", value: 50, currency: "USD", probability: 0, expectedClose: istDate(25) } })).status).toBe(200);
    const d = await db.dealDetails.findUniqueOrThrow({ where: { projectId: id } }); expect(d.need).toBe("fit"); expect(d.probability).toBe(0);
    const unknown = await customStage(["unknownConfiguredField"]), id2 = await fixture("unsupported"); const p = await preview(id2); expect(p.target.stages.find((s: { id: string }) => s.id === unknown.id).unsupportedFields).toEqual(["unknownConfiguredField"]);
    const before2 = await snapshot(id2); const r = await leader.c.post(url(id2), await body(id2, { stageId: unknown.id })); expect(r.status).toBe(409); expect(r.json.error).toContain("unsupported"); expect(await snapshot(id2)).toEqual(before2);
  });
  it("supports PAUSED and ACTIVE open stages without silently selecting a mapping", async () => {
    const target = await customStage([], false, "PAUSED");
    for (const cat of ["ACTIVE", "PAUSED"]) {
      const id = await fixture(`open ${cat}`); await db.project.update({ where: { id }, data: { stageId: proactive.stages.find((s) => s.category === cat)!.id } });
      const p = await preview(id); expect(p.target.stages.some((s: { id: string }) => s.id === target.id)).toBe(true); expect(p.stageId).toBeUndefined();
      expect((await leader.c.post(url(id), await body(id, { stageId: target.id }))).status).toBe(200);
    }
  });
  it("refuses stale facts, stage, and stage-configuration snapshots without any conversion side effects", async () => {
    const stage = await customStage([]);
    for (const change of ["facts", "stage", "config"]) {
      const id = await fixture(`stale ${change}`), b = await body(id, { stageId: stage.id });
      if (change === "facts") expect((await leader.c.patch(`/api/projects/${id}/deal`, { need: "ZZ-TEST changed after preview" })).status).toBe(200);
      if (change === "stage") expect((await leader.c.post(`/api/projects/${id}/stage`, { stageId: proactive.stages.find((s) => s.category === "ACTIVE" && s.id !== proactive.stages[0].id)!.id })).status).toBe(200);
      if (change === "config") await db.stage.update({ where: { id: stage.id }, data: { name: "ZZ-TEST changed after preview" } });
      const before = await snapshot(id), r = await leader.c.post(url(id), b); expect(r.status).toBe(409); expect(r.json.stale).toBe(true); expect(await snapshot(id)).toEqual(before);
    }
  });
  it("commits exactly once under simultaneous conversion requests", async () => {
    const id = await fixture("double"), b = await body(id);
    const results = await Promise.all([leader.c.post(url(id), b), editor.c.post(url(id), b)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.actionLog.count({ where: { projectId: id, action: "deal.pipeline_converted" } })).toBe(1);
    expect(await db.auditLog.count({ where: { targetId: id, event: "DEAL_PIPELINE_CONVERTED" } })).toBe(1);
  });
  it("keeps pipeline/stage pairing valid during overlapping old-stage requests", async () => {
    for (let n = 0; n < 4; n++) {
      const id = await fixture(`race ${n}`), p = await previewBidConversion(actor(leader), id);
      const r = await Promise.allSettled([convertToBid(actor(leader), id, { expectedRevision: p.revision, stageId: bid.stages[0].id, submissionDeadline: istDate(20) }), moveStage(actor(editor), id, { stageId: proactive.stages.find((s) => s.category === "ACTIVE" && s.id !== proactive.stages[0].id)!.id })]);
      expect(r.some((x) => x.status === "fulfilled")).toBe(true);
      const state = await db.project.findUniqueOrThrow({ where: { id }, include: { stage: true } }); expect(state.stage!.pipelineId).toBe(state.pipelineId);
      expect(r.filter((x) => x.status === "rejected").every((x) => [400, 409].includes((x as PromiseRejectedResult).reason.status))).toBe(true);
    }
  });
  it("rechecks CRM visibility and active-account status at commit", async () => {
    const id = await fixture("hidden"), p = await previewBidConversion(actor(leader), id), b = { expectedRevision: p.revision, stageId: bid.stages[0].id, submissionDeadline: istDate(20) }, before = await snapshot(id);
    const old = process.env.CRM_VISIBLE;
    try { process.env.CRM_VISIBLE = "off"; await expect(convertToBid(actor(leader), id, b)).rejects.toMatchObject({ status: 404 }); }
    finally { if (old === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = old; }
    await db.user.update({ where: { id: editor.id }, data: { deactivatedAt: new Date() } });
    try { await expect(convertToBid(actor(editor), id, b)).rejects.toMatchObject({ status: 401 }); }
    finally { await db.user.update({ where: { id: editor.id }, data: { deactivatedAt: null } }); }
    expect(await snapshot(id)).toEqual(before);
  });
});
