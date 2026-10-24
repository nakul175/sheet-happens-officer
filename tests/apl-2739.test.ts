// APL-2739 (APL-2529 AC3). Negotiation lists value and currency, so a move there without them is refused
// with 409 needsFields until they are sent with the move. Server must run as in crm1.test.ts.
import { describe, expect, it } from "vitest";
import { account, istDate, type Account } from "./helpers";

type Stage = { id: string; name: string; requiredFields: string[] };
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;

/** A throwaway person: ZZ-TEST display name, run-unique nakul17+ alias (the convention in tests/helpers.ts). */
function zzAccount(role: string) {
  const n = seq++;
  return account(`ZZ-TEST ${role} ${RUN}-${n}`, `nakul17+zz-2739-${RUN}-${role}-${n}@aplyd.com`);
}

async function negotiationDeal(lead: Account, extra: Record<string, unknown> = {}) {
  const pipes = (await lead.c.get("/api/deals/pipelines")).json.pipelines as { key: string; id: string; stages: Stage[] }[];
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const org = await lead.c.post("/api/orgs", { name: `ZZ-TEST Org 2739 ${RUN}-${seq++}` });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const r = await lead.c.post("/api/deals", {
    name: `ZZ-TEST Deal 2739 ${RUN}-${seq++}`, organisationId: org.json.organisation.id, pipelineId: pro.id, leaderId: lead.id,
    whyPursue: "Strong fit", nextStep: { title: "Call the buyer", dueDate: istDate(3) }, ...extra,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { id: r.json.deal.id as string, pro, negotiation: pro.stages.find((s) => s.name === "Negotiation")! };
}

describe("qa:TC missing APL-2739 required fields on a stage move", () => {
  it("qa:TC missing AC1: Negotiation is seeded with value and currency as required fields", async () => {
    const lead = await zzAccount("seed");
    const { pro, negotiation } = await negotiationDeal(lead);
    expect(negotiation.requiredFields).toEqual(["value", "currency"]);
    // The first stage stays free, so creating or converting a deal asks for nothing new.
    expect(pro.stages[0].requiredFields).toEqual([]);
  });

  it("qa:TC missing AC1: an Editor's move without the fields is refused with 409 needsFields, then succeeds with them", async () => {
    const lead = await zzAccount("lead");
    const ed = await zzAccount("editor");
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
    const lead = await zzAccount("full");
    const { id, negotiation } = await negotiationDeal(lead, { value: 1000, currency: "USD" });
    const mv = await lead.c.post(`/api/projects/${id}/stage`, { stageId: negotiation.id });
    expect(mv.status, JSON.stringify(mv.json)).toBe(200);
  });
});
