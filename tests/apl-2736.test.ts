// APL-2736 (SHO-US-10.2 AC3). Removing a deal stage asks where its items go, and nothing is removed until
// another stage is chosen. Stages are shared by every test, so the stages that get removed are ZZ-TEST
// rows this file inserts; the seeded stages are only ever asked about, never removed.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, istDate, superAdmin, type Account } from "./helpers";
import { db } from "../src/lib/db";

type Stage = { id: string; name: string; category: string };
type Pipe = { id: string; key: string; stages: Stage[] };

const RUN = Date.now().toString(36);
const zzStages: string[] = [];
let sa: Account;
let pro: Pipe;
let bid: Pipe;
let seq = 0;

async function pipes(who: Account) {
  const r = await who.c.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  return r.json.pipelines as Pipe[];
}
const named = (p: Pipe, name: string) => p.stages.find((s) => s.name === name)!;

/** A ZZ-TEST stage at the end of the Proactive pipeline, removed in afterAll if a test left it. */
async function zzStage(category: "ACTIVE" | "DONE" = "ACTIVE") {
  const id = `st_zz_2736_${RUN}_${seq++}`;
  await db.stage.create({ data: { id, pipelineId: pro.id, name: `ZZ-TEST stage ${id}`, position: 100 + seq, category, requiredFields: [] } });
  zzStages.push(id);
  return id;
}

/** A deal led by the Super Admin, placed in `stageId`. */
async function dealIn(stageId: string) {
  const org = (await sa.c.post("/api/orgs", { name: `ZZ-TEST Org 2736 ${RUN}-${seq++}` })).json.organisation.id as string;
  const r = await sa.c.post("/api/deals", {
    name: `ZZ-TEST Deal 2736 ${RUN}-${seq++}`, organisationId: org, pipelineId: pro.id, leaderId: sa.id, whyPursue: "fit",
    nextStep: { title: "First call", dueDate: istDate(2) },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  await db.project.update({ where: { id }, data: { stageId } });
  return id;
}
const stageOf = async (dealId: string) => (await db.project.findUniqueOrThrow({ where: { id: dealId } })).stageId;
const exists = async (stageId: string) => !!(await db.stage.findUnique({ where: { id: stageId } }));

beforeAll(async () => {
  sa = await superAdmin();
  const all = await pipes(sa);
  pro = all.find((p) => p.key === "DEAL_PROACTIVE")!;
  bid = all.find((p) => p.key === "DEAL_BID")!;
});

afterAll(async () => {
  const left = await db.stage.findMany({ where: { id: { in: zzStages } }, select: { id: true } });
  for (const s of left) {
    await db.project.updateMany({ where: { stageId: s.id }, data: { stageId: named(pro, "Lead").id } });
    await db.stage.delete({ where: { id: s.id } });
  }
});

describe("qa:TC missing APL-2736 removing a stage asks where its items go", () => {
  it("qa:TC missing AC1: a stage with items is not removed without a choice, and the answer asks which other stage", async () => {
    const negotiation = named(pro, "Negotiation");
    const deal = await dealIn(negotiation.id);
    const r = await sa.c.del(`/api/deals/pipelines/${negotiation.id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error).toMatch(/where/i);
    expect(r.json.error).toMatch(/another stage/i);
    expect(r.json.needsMoveTo).toBe(true);
    expect(r.json.items).toBeGreaterThanOrEqual(1);
    // Only stages the endpoint accepts as a target are offered: the other open stages that ask for no reason.
    const offered = (r.json.stages as Stage[]).map((s) => s.name);
    expect(offered).toEqual(["Lead", "Conversation", "Concept note", "Proposal"].filter((n) => pro.stages.some((s) => s.name === n)));
    expect(await exists(negotiation.id)).toBe(true);
    expect(await stageOf(deal)).toBe(negotiation.id);
    expect((await pipes(sa)).flatMap((p) => p.stages).some((s) => s.id === negotiation.id)).toBe(true);
  });

  it("qa:TC missing AC1: once another stage is chosen, the items move there and the stage is removed", async () => {
    const zz = await zzStage();
    const deal = await dealIn(zz);
    await db.project.update({ where: { id: deal }, data: { stageReason: "ZZ-TEST reason for the removed stage" } });
    const proposal = named(pro, "Proposal");
    const r = await sa.c.del(`/api/deals/pipelines/${zz}?moveTo=${proposal.id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ removed: { id: zz }, movedTo: { id: proposal.id, name: "Proposal" }, items: 1 });
    expect(await exists(zz)).toBe(false);
    expect(await stageOf(deal)).toBe(proposal.id);
    expect((await db.project.findUniqueOrThrow({ where: { id: deal } })).stageReason, "the old stage's reason is cleared").toBeNull();
    expect((await pipes(sa)).flatMap((p) => p.stages).some((s) => s.id === zz)).toBe(false);
    const audit = await db.auditLog.findFirst({ where: { event: "STAGE_REMOVED", targetId: zz } });
    expect(audit?.actorId).toBe(sa.id);
  });

  it("qa:TC missing AC1: an empty stage still asks before it is removed", async () => {
    const zz = await zzStage();
    const r = await sa.c.del(`/api/deals/pipelines/${zz}`);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ needsMoveTo: true, items: 0 });
    expect(await exists(zz)).toBe(true);
  });

  it("qa:TC missing AC1: the chosen stage must be another open stage of the same pipeline", async () => {
    const zz = await zzStage();
    const deal = await dealIn(zz);
    for (const moveTo of [zz, named(bid, "Preparing").id, named(pro, "Won").id, named(pro, "Lost").id, named(pro, "On hold").id, "st_nope"]) {
      const r = await sa.c.del(`/api/deals/pipelines/${zz}?moveTo=${moveTo}`);
      expect(r.status, `${moveTo} ${JSON.stringify(r.json)}`).toBe(400);
    }
    expect(await exists(zz)).toBe(true);
    expect(await stageOf(deal)).toBe(zz);
  });

  it("qa:TC missing AC1: every stage the answer offers is accepted as the target", async () => {
    const zz = await zzStage();
    const asked = await sa.c.del(`/api/deals/pipelines/${zz}`);
    expect(asked.status).toBe(409);
    const offered = asked.json.stages as Stage[];
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((s) => s.category === "ACTIVE" || s.category === "NOT_STARTED"), JSON.stringify(offered)).toBe(true);
    // Picking one of the offered stages is accepted, and the deal moves there.
    const deal = await dealIn(zz);
    const pick = offered[offered.length - 1];
    const r = await sa.c.del(`/api/deals/pipelines/${zz}?moveTo=${pick.id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await stageOf(deal)).toBe(pick.id);
  });

  it("qa:TC missing AC1: a stage no other stage can take items from is refused without asking where they go", async () => {
    const lost = named(pro, "Lost");
    for (const path of [`/api/deals/pipelines/${lost.id}`, `/api/deals/pipelines/${lost.id}?moveTo=${named(pro, "Proposal").id}`]) {
      const r = await sa.c.del(path);
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      expect(r.json.error).toMatch(/cannot be removed/);
      expect(r.json.needsMoveTo).toBeUndefined();
      expect(r.json.stages).toBeUndefined();
    }
    expect(await exists(lost.id)).toBe(true);
  });

  it("qa:TC missing AC1: a deal moved into the stage while it is being removed goes to the chosen stage, never to no stage", async () => {
    const zz = await zzStage();
    const proposal = named(pro, "Proposal");
    const deal = await dealIn(named(pro, "Lead").id);
    const mover = new pg.Client({ connectionString: process.env.DATABASE_URL });
    const watcher = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await mover.connect();
    await watcher.connect();
    try {
      // The mover puts the deal in the stage and holds its transaction open while the removal runs.
      await mover.query("BEGIN");
      await mover.query(`UPDATE "Project" SET "stageId" = $1 WHERE "id" = $2`, [zz, deal]);
      const removing = sa.c.del(`/api/deals/pipelines/${zz}?moveTo=${proposal.id}`);
      // Wait until the removal is blocked on a lock held by the mover, so the two really overlap.
      const pid = (await mover.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      const deadline = Date.now() + 15000;
      for (;;) {
        const w = await watcher.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
        if (w.rows[0].n > 0) break;
        if (Date.now() > deadline) throw new Error("the removal never waited on the mover");
        await new Promise((res) => setTimeout(res, 50));
      }
      await mover.query("COMMIT");
      const r = await removing;
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    } finally {
      await mover.query("ROLLBACK").catch(() => {});
      await mover.end();
      await watcher.end();
    }
    expect(await stageOf(deal), "the deal is not left with no stage").toBe(proposal.id);
    expect(await exists(zz)).toBe(false);
  });

  it("qa:TC missing AC1: only the Super Admin removes a stage", async () => {
    const zz = await zzStage();
    const member = await account("zz2736member");
    const r = await member.c.del(`/api/deals/pipelines/${zz}?moveTo=${named(pro, "Proposal").id}`);
    expect(r.status).toBe(404);
    expect(await exists(zz)).toBe(true);
  });

  it("qa:TC missing AC1: a pipeline's only Done stage cannot be removed", async () => {
    const won = named(pro, "Won");
    const r = await sa.c.del(`/api/deals/pipelines/${won.id}?moveTo=${named(pro, "Proposal").id}`);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Done stage/);
    expect(await exists(won.id)).toBe(true);
    // A second Done stage may go, and its items move to the other Done stage.
    const zzDone = await zzStage("DONE");
    expect((await sa.c.del(`/api/deals/pipelines/${zzDone}?moveTo=${won.id}`)).status).toBe(200);
    expect(await exists(zzDone)).toBe(false);
  });
});
