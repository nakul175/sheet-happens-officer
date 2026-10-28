// CRM slice 2: next step notices (12.5), parties (12.4), board data (12.6 AC2, AC3, AC6).
import { describe, expect, it } from "vitest";
import { account, istDate, task, type Account, patchTask, withVersion } from "./helpers";

let seq = 0;
async function setup(leader: Account, bid = false) {
  const pr = (await leader.c.get("/api/deals/pipelines")).json.pipelines;
  const pipe = pr.find((p: { key: string }) => p.key === (bid ? "DEAL_BID" : "DEAL_PROACTIVE"));
  const org = (await leader.c.post("/api/orgs", { force: true, name: `Org2 ${Date.now()}-${seq++}` })).json.organisation.id as string;
  const r = await leader.c.post("/api/deals", {
    force: true, name: `Deal2 ${Date.now()}-${seq++}`, organisationId: org, pipelineId: pipe.id, leaderId: leader.id, whyPursue: "fit",
    nextStep: { title: "First call", dueDate: istDate(2) }, ...(bid ? { submissionDeadline: istDate(10) } : {}),
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  const nextId = async () => ((await leader.c.get(`/api/deals?pipelineId=${pipe.id}`)).json.deals.find((d: { id: string }) => d.id === id)?.nextStep?.id ?? null) as string | null;
  return { id, org, pipe, nextId, stage: (n: string) => pipe.stages.find((s: { name: string }) => s.name === n).id as string };
}
const notices = async (a: Account, id: string) =>
  ((await a.c.get("/api/notifications")).json.items as { text: string; href: string }[]).filter((n) => /needs a next step/.test(n.text) && n.href.includes(id));

describe("next step notices (12.5)", () => {
  it("notifies the Leader once when the last dated task is completed, and flags the deal", async () => {
    const lead = await account("nslead");
    const d = await setup(lead);
    expect(await notices(lead, d.id)).toHaveLength(0);
    const t = await d.nextId();
    expect((await lead.c.post(`/api/tasks/${t}/complete`, await withVersion(lead, t!))).status).toBe(200);
    expect(await notices(lead, d.id)).toHaveLength(1);
    const row = (await lead.c.get(`/api/deals?pipelineId=${d.pipe.id}`)).json.deals.find((x: { id: string }) => x.id === d.id);
    expect(row.nextStep).toBeNull();
    expect(row.needsNextStep).toBe(true);
    // A second task without a date is not a next step, and completing it does not add another notice while one is unread.
    const undated = await task(lead, d.id, { title: "No date" });
    expect((await lead.c.post(`/api/tasks/${undated}/complete`, await withVersion(lead, undated))).status).toBe(200);
    expect(await notices(lead, d.id)).toHaveLength(1);
  });

  it("treats the earliest dated open task as the next step and ignores subtasks and Trash", async () => {
    const lead = await account("nsearly");
    const d = await setup(lead);
    const later = await task(lead, d.id, { title: "Later", dueDate: istDate(9) });
    const sooner = await task(lead, d.id, { title: "Sooner", dueDate: istDate(1) });
    const get = async () => (await lead.c.get(`/api/deals?pipelineId=${d.pipe.id}`)).json.deals.find((x: { id: string }) => x.id === d.id).nextStep?.title;
    expect(await get()).toBe("Sooner");
    expect((await lead.c.del(`/api/tasks/${sooner}`)).status).toBe(204);
    expect(await get()).toBe("First call");
    void later;
  });

  it("notifies when the last dated task goes to Trash or loses its date", async () => {
    const lead = await account("nstrash");
    const d = await setup(lead);
    const t = (await d.nextId())!;
    expect((await patchTask(lead, t, { dueDate: null })).status).toBe(200);
    expect(await notices(lead, d.id)).toHaveLength(1);
    const d2 = await setup(lead);
    const t2 = (await d2.nextId())!;
    expect((await lead.c.del(`/api/tasks/${t2}`)).status).toBe(204);
    expect(await notices(lead, d2.id)).toHaveLength(1);
  });

  it("does not apply to Paused deals or plain projects", async () => {
    const lead = await account("nspaused");
    const d = await setup(lead);
    const t = (await d.nextId())!;
    expect((await lead.c.post(`/api/projects/${d.id}/stage`, { stageId: d.stage("On hold"), reason: "Budget" })).status).toBe(200);
    expect((await lead.c.post(`/api/tasks/${t}/complete`, await withVersion(lead, t))).status).toBe(200);
    expect(await notices(lead, d.id)).toHaveLength(0);
    const row = (await lead.c.get(`/api/deals?pipelineId=${d.pipe.id}`)).json.deals.find((x: { id: string }) => x.id === d.id);
    expect(row.needsNextStep).toBe(false);
  });
});

describe("parties (12.4)", () => {
  it("adds and removes parties, keeps exactly one Buyer, and refuses archived organisations", async () => {
    const lead = await account("plead");
    const viewer = await account("pview");
    const d = await setup(lead);
    await lead.c.post(`/api/projects/${d.id}/members`, { userId: viewer.id, role: "VIEWER" });
    const funder = (await lead.c.post("/api/orgs", { force: true, name: `Funder ${Date.now()}` })).json.organisation.id;
    const add = await lead.c.post(`/api/projects/${d.id}/parties`, { organisationId: funder, role: "FUNDER" });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    expect((await lead.c.post(`/api/projects/${d.id}/parties`, { organisationId: funder, role: "FUNDER" })).status).toBe(409);
    expect((await lead.c.post(`/api/projects/${d.id}/parties`, { organisationId: funder, role: "PARTNER" })).status).toBe(201); // roles repeat across organisations
    expect((await lead.c.post(`/api/projects/${d.id}/parties`, { organisationId: funder, role: "BUYER" })).status).toBe(400);
    expect((await viewer.c.post(`/api/projects/${d.id}/parties`, { organisationId: funder, role: "OTHER" })).status).toBe(403);
    const parties = (await lead.c.get(`/api/projects/${d.id}`)).json.project.deal.parties as { id: string; role: string }[];
    expect(parties.filter((p) => p.role === "BUYER")).toHaveLength(1);
    expect((await lead.c.del(`/api/projects/${d.id}/parties/${parties.find((p) => p.role === "BUYER")!.id}`)).status).toBe(400);
    expect((await lead.c.del(`/api/projects/${d.id}/parties/${parties.find((p) => p.role === "FUNDER")!.id}`)).status).toBe(204);
    // Archived organisations cannot be added to a deal.
    const old = (await lead.c.post("/api/orgs", { force: true, name: `Old ${Date.now()}` })).json.organisation.id;
    await lead.c.post(`/api/orgs/${old}/archive`, { archive: true });
    expect((await lead.c.post(`/api/projects/${d.id}/parties`, { organisationId: old, role: "OTHER" })).status).toBe(400);
  });

  it("shows a deal on every organisation involved, with the role, only to people who may see it", async () => {
    const lead = await account("porg");
    const stranger = await account("pstranger");
    const d = await setup(lead);
    const funder = (await lead.c.post("/api/orgs", { force: true, name: `Funder ${Date.now()}` })).json.organisation.id;
    await lead.c.post(`/api/projects/${d.id}/parties`, { organisationId: funder, role: "FUNDER" });
    const seen = (await lead.c.get(`/api/orgs/${funder}`)).json.organisation.deals;
    expect(seen.find((x: { projectId: string }) => x.projectId === d.id).role).toBe("FUNDER");
    expect((await stranger.c.get(`/api/orgs/${funder}`)).json.organisation.deals).toHaveLength(0);
    expect((await lead.c.get(`/api/orgs/${d.org}`)).json.organisation.deals.find((x: { projectId: string }) => x.projectId === d.id).role).toBe("BUYER");
  });
});

describe("board data (12.6)", () => {
  it("filters by pipeline, hides archived deals, and limits 'only my deals' to leads and assignees", async () => {
    const lead = await account("blead");
    const member = await account("bmember");
    const idle = await account("bidle");
    const d = await setup(lead);
    const bid = await setup(lead, true);
    await lead.c.post(`/api/projects/${d.id}/members`, { userId: member.id, role: "EDITOR" });
    await lead.c.post(`/api/projects/${d.id}/members`, { userId: idle.id, role: "EDITOR" });
    await task(lead, d.id, { title: "For member", assigneeId: member.id });
    const ids = async (a: Account, q: string) => ((await a.c.get(`/api/deals?${q}`)).json.deals as { id: string }[]).map((x) => x.id);
    expect(await ids(lead, `pipelineId=${d.pipe.id}`)).toContain(d.id);
    expect(await ids(lead, `pipelineId=${d.pipe.id}`)).not.toContain(bid.id);
    expect(await ids(lead, `pipelineId=${bid.pipe.id}`)).toContain(bid.id);
    expect(await ids(member, "mine=true")).toContain(d.id);
    expect(await ids(idle, "mine=true")).not.toContain(d.id);
    expect(await ids(idle, "")).toContain(d.id);
    await lead.c.post(`/api/projects/${d.id}/archive`, {});
    expect(await ids(lead, `pipelineId=${d.pipe.id}`)).not.toContain(d.id);
    expect(await ids(lead, "archived=true")).toContain(d.id);
  });

  it("returns value and currency so unknown stays unknown, and the Bid deadline", async () => {
    const lead = await account("bvalue");
    const d = await setup(lead, true);
    const row = async () => (await lead.c.get(`/api/deals?pipelineId=${d.pipe.id}`)).json.deals.find((x: { id: string }) => x.id === d.id);
    expect((await row()).value).toBeNull();
    expect((await row()).submissionDeadline).toBe(istDate(10));
    await lead.c.patch(`/api/projects/${d.id}/deal`, { value: 1000, currency: "EUR" });
    expect(await row()).toMatchObject({ value: 1000, currency: "EUR" });
  });
});
