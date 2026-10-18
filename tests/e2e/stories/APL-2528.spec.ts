// SHO-US-10.2 Pipelines and stages as configuration  (Linear APL-2528)
// Source: acceptance criteria in the Linear issue. Runs against staging; credentials come from the environment (see playwright.config.ts).
import { test, expect, type Json } from "../support";

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
    "Identified:ACTIVE:false", "Go/No-go:ACTIVE:false", "Preparing:ACTIVE:false", "Submitted:ACTIVE:false", "Awaiting result:ACTIVE:false",
    "Won:DONE:false", "Lost:LOST:true",
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

test("AC1 (screen): the Deals screen shows the Proactive stages as board columns", async ({ admin }) => {
  await admin.page.goto("/deals");
  await expect(admin.page.getByText("Negotiation").first()).toBeVisible();
});

test.skip("AC3: removing a stage asks where its items go", () => {
  // Reason: the Linear issue states AC3 is NOT built. Nothing in the product removes a stage; stages change by migration only.
});

test.skip("AC4: every pipeline keeps a Done stage", () => {
  // Reason: the Linear issue states AC4 is NOT enforced in code (only seeded). There is no user action that could remove it.
});
