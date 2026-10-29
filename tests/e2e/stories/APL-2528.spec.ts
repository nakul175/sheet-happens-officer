import { archiveProject } from "../helpers/migration-2731";
import { test } from "./qa";
// SHO-US-10.2 Pipelines and stages as configuration  (Linear APL-2528)
// Source: acceptance criteria in the Linear issue. Runs against staging; credentials come from the environment (see playwright.config.ts).
import { expect, zz, type Json } from "../support";

type Stage = { id: string; name: string; position: number; category: string; needsReason: boolean; requiredFields: string[] };
type Pipe = { id: string; key: string; name: string; stages: Stage[] };

async function pipelines(admin: { api: { get: (p: string) => Promise<{ status: number; json: Json }> } }) {
  const r = await admin.api.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  return r.json.pipelines as Pipe[];
}

test("AC1: the Proactive and Bid deal pipelines exist with the agreed stages and categories", async ({ admin }) => {
  const pipes = await pipelines(admin);
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const bid = pipes.find((p) => p.key === "DEAL_BID")!;
  expect(pro, "Proactive pipeline").toBeTruthy();
  expect(bid, "Bid pipeline").toBeTruthy();
  const view = (p: Pipe) => p.stages.slice().sort((a, b) => a.position - b.position).map((s) => `${s.name}:${s.category}:${s.needsReason}`);
  expect(view(pro)).toEqual([
    "Lead:ACTIVE:false", "Conversation:ACTIVE:false", "Concept note:ACTIVE:false", "Proposal:ACTIVE:false", "Negotiation:ACTIVE:false",
    "On hold:PAUSED:true", "Won:DONE:false", "Lost:LOST:true",
  ]);
  expect(view(bid)).toEqual([
    // Released20261024110100_bid_stage_mapping supersedes the original Bid seed.
    "Leads:ACTIVE:false", "Under Evaluation:ACTIVE:false", "Go:ACTIVE:false", "No-Go:LOST:true", "Submitted:ACTIVE:false",
    "Won:DONE:false", "Lost:LOST:true", "On Hold:PAUSED:true", "Ongoing Projects:DELIVERY:false",
  ]);
});

test("AC2: each pipeline owns its own stage rows, so changing one leaves the other unchanged", async ({ admin }) => {
  const pipes = await pipelines(admin);
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const bid = pipes.find((p) => p.key === "DEAL_BID")!;
  const proIds = new Set(pro.stages.map((s) => s.id));
  const shared = bid.stages.filter((s) => proIds.has(s.id));
  expect(shared, "no stage row is shared between pipelines (even Won and Lost)").toEqual([]);
});

test("AC1 (screen): the Deals screen shows the Proactive stages as board columns", async ({ admin, later }) => {
  const pipe = (await pipelines(admin)).find(p => p.key === "DEAL_PROACTIVE")!;
  const org = await admin.api.post("/api/orgs", { name: zz("2528 board org") });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  later(() => admin.api.post(`/api/orgs/${org.json.organisation.id}/archive`, { archive: true }));
  const deal = await admin.api.post("/api/deals", { name: zz("2528 board deal"), organisationId: org.json.organisation.id, pipelineId: pipe.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST", nextStep: { title: zz("2528 first step"), dueDate: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10) } });
  expect(deal.status, JSON.stringify(deal.json)).toBe(201);
  later(() => archiveProject(admin.api, deal.json.deal.id, admin.user.id));
  await admin.page.goto("/deals");
  await expect(admin.page.getByRole("region", { name: "Negotiation", exact: true }).first()).toBeVisible();
});

test("AC3: removing a stage asks where its items go", async ({ admin }) => {
  const before = await pipelines(admin);
  const pipeline = before.find(p => p.key === "DEAL_PROACTIVE")!;
  const stage = pipeline.stages.find(s => s.name === "Lead")!;
  const refused = await admin.api.del(`/api/deals/pipelines/${stage.id}`);
  expect(refused.status, JSON.stringify(refused.json)).toBe(409);
  expect(refused.json.needsMoveTo).toBe(true);
  expect(refused.json.error).toMatch(/Choose another stage/);
  expect(refused.json.stages.length).toBeGreaterThan(0);
  expect(await pipelines(admin), "a missing destination must not remove or change stages").toEqual(before);
});

test("AC4: every pipeline keeps a Done stage", async ({ admin }) => {
  const before = await pipelines(admin);
  for (const pipeline of before) {
    const done = pipeline.stages.filter(s => s.category === "DONE");
    expect(done, `${pipeline.name} has exactly one protected Done stage`).toHaveLength(1);
    const refused = await admin.api.del(`/api/deals/pipelines/${done[0].id}`);
    expect(refused.status, JSON.stringify(refused.json)).toBe(409);
    expect(refused.json.error).toMatch(/must keep a Done stage/);
  }
  expect(await pipelines(admin), "refused deletion preserves every pipeline").toEqual(before);
});
