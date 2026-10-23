// SHO-2736 (SHO-US-10.2 AC3) proved LOCALLY: the Super Admin's address is inside ALLOWED_DOMAINS here
// (src/lib/schemas.ts:5), which is exactly what staging cannot do, so the route is reachable and the AC runs.
// This file is the acceptance run, and the regression guard for the two things that would make it a lie:
// a removal question that counts fewer items than the stage holds, and a move that carries a deal that was
// never in the removed stage. Stages are shared, so the stage removed here is a ZZ-TEST row this file inserts;
// the seeded stages are only asked about (`moveTo` targets), never removed.
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
let seq = 0;

async function pipes(who: Account) {
  const r = await who.c.get("/api/deals/pipelines");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.pipelines as Pipe[];
}
const named = (p: Pipe, name: string) => {
  const s = p.stages.find((x) => x.name === name);
  expect(s, `${p.key} has a stage named "${name}"`).toBeTruthy();
  return s!;
};

/** A ZZ-TEST stage at the end of the Proactive pipeline. Inserted directly: the product has no API that creates a stage. */
async function zzStage(category: "ACTIVE" | "DONE" = "ACTIVE") {
  const id = `st_zz_sho2736_${RUN}_${seq++}`;
  await db.stage.create({
    data: { id, pipelineId: pro.id, name: `ZZ-TEST SHO-2736 ${id}`, position: 100 + seq, category, requiredFields: [], needsReason: false },
  });
  zzStages.push(id);
  return id;
}

/** A deal led by the Super Admin, left in `stageId` (moved there through the stage-move API). */
async function dealIn(stageId: string) {
  const org = (await sa.c.post("/api/orgs", { name: `ZZ-TEST Org SHO-2736 ${RUN}-${seq++}` })).json.organisation.id as string;
  zzOrgs.push(org);
  const r = await sa.c.post("/api/deals", {
    name: `ZZ-TEST Deal SHO-2736 ${RUN}-${seq++}`, organisationId: org, pipelineId: pro.id, leaderId: sa.id, whyPursue: "fit",
    value: 1000, currency: "USD", nextStep: { title: "First call", dueDate: istDate(2) },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  zzDeals.push(id);
  if (stageId !== named(pro, "Lead").id) {
    const m = await sa.c.post(`/api/projects/${id}/stage`, { stageId });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
  }
  return id;
}
const stageOf = async (dealId: string) => (await db.project.findUniqueOrThrow({ where: { id: dealId } })).stageId;
const exists = async (stageId: string) => !!(await db.stage.findUnique({ where: { id: stageId } }));

beforeAll(async () => {
  sa = await superAdmin();
  pro = (await pipes(sa)).find((p) => p.key === "DEAL_PROACTIVE")!;
  expect(pro, "the Proactive deal pipeline is seeded").toBeTruthy();
});

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

describe("SHO-2736 AC1, proved locally where the Super Admin can sign up", () => {
  it("the account in SUPER_ADMIN_EMAILS is inside ALLOWED_DOMAINS and /api/auth/me says SUPER_ADMIN", async () => {
    // The staging blocker in one line: src/lib/deals.ts:237 needs orgRole === "SUPER_ADMIN", and staging's
    // signup refuses the address that would hold it (src/lib/schemas.ts:5). Here the two agree.
    expect(sa.email).toMatch(/@(aplyd|athenainfonomics)\.com$/);
    const me = await sa.c.get("/api/auth/me");
    expect(me.status, JSON.stringify(me.json)).toBe(200);
    expect(me.json.user.orgRole, "the removal route's guard is satisfied before the route is even called").toBe("SUPER_ADMIN");
  });

  it("every destination the question offers is honoured, so no default stage is doing the moving", async () => {
    // AC1 is about a CHOSEN destination: one hard-coded stage answering for all of them would still pass a test
    // that only ever picks one. The question's own offer list is the yardstick, and each entry is tried.
    const probe = await zzStage();
    const asked = await sa.c.del(`/api/deals/pipelines/${probe}`);
    expect(asked.status, JSON.stringify(asked.json)).toBe(409);
    const offered = asked.json.stages as Stage[];
    expect(offered.length, "more than one destination is offered").toBeGreaterThan(1);
    expect((await sa.c.del(`/api/deals/pipelines/${probe}?moveTo=${offered[0].id}`)).status).toBe(200);

    for (const dest of offered) {
      const zz = await zzStage();
      const deal = await dealIn(zz);
      const r = await sa.c.del(`/api/deals/pipelines/${zz}?moveTo=${dest.id}`);
      expect(r.status, `${dest.name}: ${JSON.stringify(r.json)}`).toBe(200);
      expect(r.json, `the answer names ${dest.name}`).toMatchObject({ removed: { id: zz }, movedTo: { id: dest.id, name: dest.name }, items: 1 });
      expect(await stageOf(deal), `the item lands in ${dest.name}, the stage that was chosen`).toBe(dest.id);
      expect(await exists(zz), "and the stage it came from is gone").toBe(false);
    }
  });

  it("deals sit in two different stages; removing a third stage that holds items asks first, then moves exactly those items", async () => {
    const lead = named(pro, "Lead");
    const conversation = named(pro, "Conversation");
    const proposal = named(pro, "Proposal"); // the legal target, see below

    // The two stages that must be left alone. Created first, so a count that reached past the stage
    // would read 4 rather than 2, and this test fails.
    const inLead = await dealIn(lead.id);
    const inConversation = await dealIn(conversation.id);

    // The third stage, holding two items of its own.
    const zz = await zzStage();
    const a1 = await dealIn(zz);
    const a2 = await dealIn(zz);
    expect(await stageOf(a1)).toBe(zz);
    expect(await stageOf(a2)).toBe(zz);

    // A non-Super-Admin is told the stage does not exist, and it is still there afterwards.
    const member = await account("zzsho2736member");
    zzPeople.push(member.id);
    const refused = await member.c.del(`/api/deals/pipelines/${zz}?moveTo=${proposal.id}`);
    expect(refused.status, JSON.stringify(refused.json)).toBe(404);
    expect(await exists(zz)).toBe(true);
    expect(await stageOf(a1)).toBe(zz);

    // Without moveTo: 409, naming the question, the item count and the stages that can take them.
    const asked = await sa.c.del(`/api/deals/pipelines/${zz}`);
    expect(asked.status, JSON.stringify(asked.json)).toBe(409);
    expect(asked.json).toMatchObject({ needsMoveTo: true, items: 2 });
    expect(asked.json.error, "the answer says where, and how many").toMatch(/Where should the 2 items/);
    expect(asked.json.error).toContain("ZZ-TEST SHO-2736");
    const offered = (asked.json.stages as Stage[]).map((s) => s.id);
    expect(offered, "every stage canTake accepts is offered").toContain(proposal.id);
    expect(offered, "and the stage being removed is not").not.toContain(zz);
    // Nothing moved and nothing was removed while the answer waited.
    expect(await exists(zz)).toBe(true);
    expect(await stageOf(a1)).toBe(zz);
    expect(await stageOf(a2)).toBe(zz);
    expect(await stageOf(inLead)).toBe(lead.id);
    expect(await stageOf(inConversation)).toBe(conversation.id);

    // With moveTo: 200, the stage goes, and only the stage's own items move.
    // Proposal is legal for this removed ZZ-TEST stage (src/lib/deals.ts:244-247): both are open
    // (ACTIVE/NOT_STARTED), Proposal needs no reason and asks for no field the removed stage did not.
    // "On hold" would be refused (it needs a reason), and Won/Lost (another category) too.
    const done = await sa.c.del(`/api/deals/pipelines/${zz}?moveTo=${proposal.id}`);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toMatchObject({ removed: { id: zz }, movedTo: { id: proposal.id, name: "Proposal" }, items: 2 });
    expect(await stageOf(a1), "the first item lands in the chosen stage").toBe(proposal.id);
    expect(await stageOf(a2), "the second item too").toBe(proposal.id);
    expect(await stageOf(inLead), "a deal in another stage is not dragged along").toBe(lead.id);
    expect(await stageOf(inConversation), "nor the second one").toBe(conversation.id);
    expect(await exists(zz), "the stage is gone").toBe(false);
    expect((await pipes(sa)).flatMap((p) => p.stages).some((s) => s.id === zz), "and gone from the picker").toBe(false);
    // Nothing at all is left pointing at it, and no deal was left with no stage.
    expect(await db.project.count({ where: { stageId: zz } })).toBe(0);
    expect(await db.project.count({ where: { id: { in: [a1, a2] }, stageId: null } })).toBe(0);
  });
});
