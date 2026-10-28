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
const zzOrgs: string[] = [];
const zzDeals: string[] = [];
const zzPeople: string[] = [];
let sa: Account;
let pro: Pipe;
let bid: Pipe;
let seq = 0;

/**
 * The local test database, for the two raw pg connections the race test needs (SHO-2736). Prisma's `?schema=` is
 * Prisma-only: the pg driver would send it as an unknown startup setting, so it is carried over as `search_path`
 * instead. Without that the raw connections land in `public` while Prisma - and the route under test - work in the
 * named schema, so the mover holds a row lock on a deal nobody is looking at and the race never overlaps.
 */
const testSchema = () => new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ?? "public";

function rawDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required and must point at the local test database");
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new Error("Refusing to run: the stage-removal race test uses the local test database only");
  }
  const schema = url.searchParams.get("schema");
  url.search = "";
  if (schema) url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString().replaceAll("+", "%20");
}

async function pipes(who: Account) {
  const r = await who.c.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  return r.json.pipelines as Pipe[];
}
const named = (p: Pipe, name: string) => p.stages.find((s) => s.name === name)!;

/** A ZZ-TEST stage at the end of the Proactive pipeline, removed in afterAll if a test left it. */
async function zzStage(category: "ACTIVE" | "DONE" = "ACTIVE") {
  const id = `st_zz_2736_${RUN}_${seq++}`;
  // Allowed direct DB write (ZZ-TEST setup only): the product has no API that creates a stage (stages are
  // migration-only), so the ZZ-TEST stage is inserted here. It is removed through DELETE /api/deals/pipelines/:id in afterAll.
  await db.stage.create({ data: { id, pipelineId: pro.id, name: `ZZ-TEST stage ${id}`, position: 100 + seq, category, requiredFields: [] } });
  zzStages.push(id);
  return id;
}

/** A deal led by the Super Admin, moved to `stageId` (with `reason`, if given) through the stage-move API. */
async function dealIn(stageId: string, reason?: string) {
  const org = (await sa.c.post("/api/orgs", { name: `ZZ-TEST Org 2736 ${RUN}-${seq++}` })).json.organisation.id as string;
  zzOrgs.push(org);
  const r = await sa.c.post("/api/deals", {
    name: `ZZ-TEST Deal 2736 ${RUN}-${seq++}`, organisationId: org, pipelineId: pro.id, leaderId: sa.id, whyPursue: "fit",
    // Value and currency up front: Negotiation asks for them on a stage move (APL-2739).
    value: 1000, currency: "USD", nextStep: { title: "First call", dueDate: istDate(2) },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  zzDeals.push(id);
  if (stageId !== named(pro, "Lead").id || reason) {
    const m = await sa.c.post(`/api/projects/${id}/stage`, { stageId, ...(reason ? { reason } : {}) });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
  }
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

// Cleanup goes through the API: leftover ZZ-TEST stages are removed by the endpoint under test, then the
// ZZ-TEST deals and organisations are archived and the ZZ-TEST person is deactivated.
afterAll(async () => {
  const problems: string[] = [];
  const left = (await pipes(sa)).flatMap((p) => p.stages).filter((s) => zzStages.includes(s.id));
  for (const s of left) {
    const to = named(pro, s.category === "DONE" ? "Won" : "Lead").id;
    const r = await sa.c.del(`/api/deals/pipelines/${s.id}?moveTo=${to}`);
    if (r.status !== 200) problems.push(`remove stage ${s.id}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  for (const id of zzDeals) {
    const r = await sa.c.post(`/api/projects/${id}/archive`);
    if (r.status !== 200) problems.push(`archive deal ${id}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  for (const id of zzOrgs) {
    const r = await sa.c.post(`/api/orgs/${id}/archive`, { archive: true });
    if (r.status !== 200) problems.push(`archive org ${id}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  for (const id of zzPeople) {
    const r = await sa.c.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
    if (r.status !== 200) problems.push(`deactivate ${id}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
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
    const deal = await dealIn(zz, "ZZ-TEST reason for the removed stage");
    expect((await db.project.findUniqueOrThrow({ where: { id: deal } })).stageReason).toBe("ZZ-TEST reason for the removed stage");
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

  it("qa:TC missing AC1: every item lands in the stage that was chosen, and two removals can choose different stages", async () => {
    // The tests around this one move a single item each: the one above picks Proposal, the "every stage the
    // answer offers" one takes offered[last]. Neither checks that a stage holding more than one item moves
    // all of them, or that a deal in a stage nobody asked about is left alone. Here two stages are removed
    // with different destinations (neither the last one offered), one holds two items, and a deal in a
    // third stage must keep its stage.
    const zzA = await zzStage();
    const zzB = await zzStage();
    const offered = ((await sa.c.del(`/api/deals/pipelines/${zzA}`)).json.stages ?? []) as Stage[];
    const byName = new Map(offered.map((s) => [s.name, s] as const));
    const conversation = byName.get("Conversation");
    const lead = byName.get("Lead");
    expect(conversation, `offered: ${offered.map((s) => s.name).join(", ")}`).toBeDefined();
    expect(lead, `offered: ${offered.map((s) => s.name).join(", ")}`).toBeDefined();
    expect(offered[offered.length - 1].id, "the last offered stage is a third one").not.toBe(conversation!.id);
    expect(offered[offered.length - 1].id).not.toBe(lead!.id);

    const a1 = await dealIn(zzA);
    const a2 = await dealIn(zzA);
    const b1 = await dealIn(zzB);
    // A deal in a stage nobody asked about. Removing zzA must not touch it.
    const untouched = await dealIn(named(pro, "Negotiation").id);

    // The question names how many items there are - two, not one - and offers both stages this test goes on to
    // choose. Nothing moves and nothing is removed while the answer waits.
    const asked = await sa.c.del(`/api/deals/pipelines/${zzA}`);
    expect(asked.status, JSON.stringify(asked.json)).toBe(409);
    expect(asked.json).toMatchObject({ needsMoveTo: true, items: 2 });
    const offeredIds = (asked.json.stages as Stage[]).map((s) => s.id);
    expect(offeredIds).toEqual(expect.arrayContaining([conversation!.id, lead!.id]));
    expect(offeredIds).not.toContain(zzA);
    expect(await exists(zzA)).toBe(true);
    expect(await stageOf(a1)).toBe(zzA);
    expect(await stageOf(a2)).toBe(zzA);

    const first = await sa.c.del(`/api/deals/pipelines/${zzA}?moveTo=${conversation!.id}`);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toMatchObject({ removed: { id: zzA }, movedTo: { id: conversation!.id, name: "Conversation" }, items: 2 });
    expect(await stageOf(a1), "the first item of the removed stage").toBe(conversation!.id);
    expect(await stageOf(a2), "the second item of the removed stage").toBe(conversation!.id);
    expect(await stageOf(untouched), "a deal in another stage is not dragged along").toBe(named(pro, "Negotiation").id);

    const second = await sa.c.del(`/api/deals/pipelines/${zzB}?moveTo=${lead!.id}`);
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json).toMatchObject({ removed: { id: zzB }, movedTo: { id: lead!.id, name: "Lead" }, items: 1 });
    expect(await stageOf(b1), "the second removal follows its own choice").toBe(lead!.id);
    // The second removal's choice did not drag the first stage's items along.
    expect(await stageOf(a1)).toBe(conversation!.id);
    expect(await stageOf(a2)).toBe(conversation!.id);
    expect(await exists(zzA)).toBe(false);
    expect(await exists(zzB)).toBe(false);
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
    for (const moveTo of [zz, named(bid, "Go").id, named(pro, "Won").id, named(pro, "Lost").id, named(pro, "On hold").id, "st_nope"]) {
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
    const mover = new pg.Client({ connectionString: rawDatabaseUrl() });
    const watcher = new pg.Client({ connectionString: rawDatabaseUrl() });
    await mover.connect();
    await watcher.connect();
    try {
      // The raw connections must see the tables the route writes, or the lock below guards no rows and this
      // test passes without ever overlapping the removal (it did: the mover sat in `public`, holding nothing).
      const where = (await watcher.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0].schema;
      expect(where, "the raw pg connections are not in the schema DATABASE_URL names").toBe(testSchema());
      // Allowed direct DB write (D1 race transaction only): the mover puts the deal in the stage and holds its
      // transaction open while the removal runs. An HTTP request cannot hold a transaction open across calls.
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
      // The deal that raced into the stage is one of the items the move carried, not a row the delete stranded.
      expect(r.json, "the raced-in deal is one of the moved items").toMatchObject({ removed: { id: zz }, movedTo: { id: proposal.id }, items: 1 });
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
    zzPeople.push(member.id);
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
