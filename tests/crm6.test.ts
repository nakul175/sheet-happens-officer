// Close-the-gaps slice: removing a pipeline stage (10.2 AC3, AC4). Uses its own throw-away pipeline so the seeded ones stay as shipped.
// Server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com; DATABASE_URL points at the same database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { account, istDate, superAdmin, task, type Account } from "./helpers";

const db = new PrismaClient();
const tag = `t6${Date.now()}`;
const PID = `pl_${tag}`;
const S = { a: `st_${tag}_a`, b: `st_${tag}_b`, won: `st_${tag}_won`, won2: `st_${tag}_won2`, lost: `st_${tag}_lost` };
let seq = 0;

beforeAll(async () => {
  await db.pipeline.create({ data: { id: PID, typeId: "wst_deal", key: `T6_${tag}`, name: `T6 ${tag}`, position: 99 } });
  await db.stage.createMany({
    data: [
      { id: S.a, pipelineId: PID, name: "Lead", position: 0, category: "ACTIVE", requiredFields: [] },
      { id: S.b, pipelineId: PID, name: "Middle", position: 1, category: "ACTIVE", requiredFields: [] },
      { id: S.won, pipelineId: PID, name: "Won", position: 2, category: "DONE", requiredFields: [] },
      { id: S.lost, pipelineId: PID, name: "Lost", position: 3, category: "LOST", needsReason: true, requiredFields: [] },
    ],
  });
});
afterAll(async () => {
  await db.project.deleteMany({ where: { pipelineId: PID } });
  await db.stage.deleteMany({ where: { pipelineId: PID } });
  await db.pipeline.deleteMany({ where: { id: PID } });
  await db.$disconnect();
});

async function deal(a: Account, stageId?: string) {
  const org = (await a.c.post("/api/orgs", { name: `Org6 ${Date.now()}-${seq++}` })).json.organisation.id;
  const r = await a.c.post("/api/deals", { name: `D6 ${Date.now()}-${seq++}`, organisationId: org, pipelineId: PID, leaderId: a.id, whyPursue: "x", nextStep: { title: "n", dueDate: istDate(4) } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  if (stageId) await db.project.update({ where: { id }, data: { stageId } });
  return id;
}
const remove = (a: Account, stage: string, body?: unknown) => a.c.call("DELETE", `/api/deals/pipelines/${PID}/stages/${stage}`, body);

describe("remove a pipeline stage (10.2)", () => {
  it("is for the Super Admin only", async () => {
    const lead = await account("rs-lead");
    expect((await remove(lead, S.b)).status).toBe(403);
  });

  it("asks where the deals go, moves them, renumbers the stages and tells the Leader", async () => {
    const sa = await superAdmin();
    const lead = await account("rs-lead2");
    const d = await deal(lead, S.b);
    const first = await remove(sa, S.b);
    expect(first.status).toBe(409);
    expect(first.json.needsTarget).toBe(true);
    expect(first.json.deals).toBeGreaterThanOrEqual(1);
    expect((await remove(sa, S.b, { moveToStageId: S.b })).status).toBe(400);
    const done = await remove(sa, S.b, { moveToStageId: S.a });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect((await db.project.findUniqueOrThrow({ where: { id: d } })).stageId).toBe(S.a);
    const left = await db.stage.findMany({ where: { pipelineId: PID }, orderBy: { position: "asc" } });
    expect(left.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(left.map((s) => s.name)).toEqual(["Lead", "Won", "Lost"]);
    const note = ((await lead.c.get("/api/notifications")).json.items as { text: string }[]).some((n) => n.text.includes("moved"));
    expect(note).toBe(true);
  });

  it("keeps one Done stage, but lets a second Done stage go", async () => {
    const sa = await superAdmin();
    const r = await remove(sa, S.won);
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/Done stage/);
    await db.stage.create({ data: { id: S.won2, pipelineId: PID, name: "Signed", position: 9, category: "DONE", requiredFields: [] } });
    expect((await remove(sa, S.won2)).status).toBe(200);
  });

  it("will not push deals with open tasks into Won or Lost", async () => {
    const sa = await superAdmin();
    const lead = await account("rs-lead3");
    await db.stage.create({ data: { id: S.b, pipelineId: PID, name: "Middle2", position: 8, category: "ACTIVE", requiredFields: [] } });
    const d = await deal(lead, S.b);
    await task(lead, d, { title: "Still open" });
    const r = await remove(sa, S.b, { moveToStageId: S.won });
    expect(r.status).toBe(409);
    expect((await db.project.findUniqueOrThrow({ where: { id: d } })).stageId).toBe(S.b);
    expect((await remove(sa, S.b, { moveToStageId: S.a })).status).toBe(200);
  });
});
