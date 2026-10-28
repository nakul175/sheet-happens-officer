// APL-2739 (APL-2529 AC3). Negotiation lists value and currency, so a move there without them is refused
// with 409 needsFields until they are sent with the move. Server must run as in crm1.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, istDate, superAdmin, BASE, type Account } from "./helpers";

import { cleanupReminderResources, reminderResources } from "./reminder-cleanup-2751";

const run = `${Date.now().toString(36)}-${process.pid}`;
const resources = reminderResources();
async function person(label: string) {
  const who = await account(`ZZ-TEST 2739 ${label} ${run}`, `nakul17+zz-2739-${label}-${run}@aplyd.com`);
  resources.people.push({ id: who.id, deactivated: false });
  return who;
}
function assertLocalTarget() {
  const local = (url: URL) => ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  const database = new URL(process.env.DATABASE_URL ?? "http://refused.invalid");
  if (!local(new URL(BASE)) || !/^https?:$/.test(new URL(BASE).protocol) || !local(database) || !/^postgres(?:ql)?:$/.test(database.protocol) || database.pathname !== "/sho_test") throw new Error("APL-2752 requires localhost test API and sho_test database");
}
beforeAll(assertLocalTarget);
afterAll(async () => {
  assertLocalTarget();
  if (!resources.people.length && !resources.projects.length && !resources.organisations.length) return;
  const root = await superAdmin();
  await cleanupReminderResources(root.id, (p, body) => root.c.post(p, body), resources);
  for (const project of resources.projects) {
    const read = await root.c.get(`/api/projects/${project.id}`);
    expect(read.status).toBe(200);
    expect(read.json.project.archived).toBe(true);
  }
});

type Stage = { id: string; name: string; requiredFields: string[] };
let seq = 0;

async function negotiationDeal(lead: Account, extra: Record<string, unknown> = {}) {
  const pipes = (await lead.c.get("/api/deals/pipelines")).json.pipelines as { key: string; id: string; stages: Stage[] }[];
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const org = await lead.c.post("/api/orgs", { name: `ZZ-TEST Org 2739 ${run}-${seq++}` });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  resources.organisations.push({ id: org.json.organisation.id, archived: false });
  const r = await lead.c.post("/api/deals", {
    name: `ZZ-TEST Deal 2739 ${run}-${seq++}`, organisationId: org.json.organisation.id, pipelineId: pro.id, leaderId: lead.id,
    whyPursue: "Strong fit", nextStep: { title: "ZZ-TEST Call the buyer", dueDate: istDate(3) }, ...extra,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  resources.projects.push({ id: r.json.deal.id, leaderId: lead.id, archived: false });
  return { id: r.json.deal.id as string, pro, negotiation: pro.stages.find((s) => s.name === "Negotiation")! };
}

describe("qa:TC missing APL-2739 required fields on a stage move", () => {
  it("qa:TC missing AC1: Negotiation is seeded with value and currency as required fields", async () => {
    const lead = await person("rf2739seed");
    const { pro, negotiation } = await negotiationDeal(lead);
    expect(negotiation.requiredFields).toEqual(["value", "currency"]);
    // The first stage stays free, so creating or converting a deal asks for nothing new.
    expect(pro.stages[0].requiredFields).toEqual([]);
  });

  it("qa:TC missing AC1: an Editor's move without the fields is refused with 409 needsFields, then succeeds with them", async () => {
    const lead = await person("rf2739lead");
    const ed = await person("rf2739ed");
    const { id, negotiation } = await negotiationDeal(lead);
    expect((await lead.c.post(`/api/projects/${id}/members`, { userId: ed.id, role: "EDITOR" })).status).toBe(201);

    const refused = await ed.c.post(`/api/projects/${id}/stage`, { stageId: negotiation.id });
    expect(refused.status).toBe(409);
    expect(refused.json.needsFields).toEqual(["value", "currency"]);
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.deal.stage.name).toBe("Lead");

    const sent = await ed.c.post(`/api/projects/${id}/stage`, { stageId: negotiation.id, fields: { value: 500000, currency: "INR" } });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const deal = (await lead.c.get(`/api/projects/${id}`)).json.project.deal;
    expect(deal.stage.name).toBe("Negotiation");
    expect(deal.details).toMatchObject({ value: 500000, currency: "INR" });
  });

  it("qa:TC missing AC1: a Leader's move with the fields already on the deal is not asked for them", async () => {
    const lead = await person("rf2739full");
    const { id, negotiation } = await negotiationDeal(lead, { value: 1000, currency: "USD" });
    const mv = await lead.c.post(`/api/projects/${id}/stage`, { stageId: negotiation.id });
    expect(mv.status, JSON.stringify(mv.json)).toBe(200);
  });
});
