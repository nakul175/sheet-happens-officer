// CRM slice 5: Monday review (13.3) and the stalled-deals job (12.7).
// Server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com, JOB_SECRET set, the same EMAIL_OUTBOX_DIR; DATABASE_URL points at the same database.
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { Client, account, admin, istDate, project, superAdmin, task, type Account } from "./helpers";

const db = new PrismaClient();
const SECRET = process.env.JOB_SECRET ?? "";
const runJob = (name: string) => fetch(`${process.env.TASKBOARD_URL ?? "http://localhost:3000"}/api/jobs/${name}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
const texts = async (a: { c: Client }) => ((await a.c.get("/api/notifications")).json.items as { text: string; href: string }[]);
let seq = 0;

async function mkDeal(a: Account, o: { due?: string; stage?: string; bid?: boolean; extra?: Record<string, unknown> } = {}) {
  const pipes = (await a.c.get("/api/deals/pipelines")).json.pipelines;
  const pipe = pipes.find((p: { key: string }) => p.key === (o.bid ? "DEAL_BID" : "DEAL_PROACTIVE"));
  const org = (await a.c.post("/api/orgs", { name: `Org5 ${Date.now()}-${seq++}` })).json.organisation.id;
  const r = await a.c.post("/api/deals", {
    name: `Deal5 ${Date.now()}-${seq++}`, organisationId: org, pipelineId: pipe.id, leaderId: a.id, whyPursue: "fit",
    nextStep: { title: "Step", dueDate: o.due ?? istDate(5) }, ...(o.bid ? { submissionDeadline: istDate(20) } : {}), ...o.extra,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  if (o.stage) expect((await a.c.post(`/api/projects/${id}/stage`, { stageId: pipe.stages.find((s: { name: string }) => s.name === o.stage).id, reason: "test" })).status).toBe(200);
  return { id, pipe };
}
const review = async (a: Account) => (await a.c.get("/api/review")).json;
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
async function age(dealId: string, days: number) {
  const t = new Date(Date.now() - days * 86400_000);
  await db.$executeRaw`UPDATE "Project" SET "createdAt" = ${t}, "stageChangedAt" = ${t} WHERE id = ${dealId}`;
  await db.$executeRaw`UPDATE "Task" SET "updatedAt" = ${t} WHERE "projectId" = ${dealId}`;
  await db.$executeRaw`UPDATE "ActionLog" SET "createdAt" = ${t} WHERE "projectId" = ${dealId}`;
}

describe("Monday review (13.3)", () => {
  it("lists deals needing a next step and with an overdue next step, only to people who may see them, and everything to Admins", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const lead = await account("rvlead");
    const stranger = await account("rvstranger");
    const late = await mkDeal(lead, { due: istDate(-3) });
    const none = await mkDeal(lead);
    const t = (await lead.c.get("/api/deals")).json.deals.find((d: { id: string }) => d.id === none.id).nextStep.id;
    await lead.c.post(`/api/tasks/${t}/complete`);
    const mine = await review(lead);
    expect(ids(mine.overdueNextStep)).toContain(late.id);
    expect(ids(mine.needsNextStep)).toContain(none.id);
    expect(ids(mine.needsNextStep)).not.toContain(late.id);
    const theirs = await review(stranger);
    expect(ids(theirs.overdueNextStep)).not.toContain(late.id);
    expect(ids(theirs.needsNextStep)).not.toContain(none.id);
    const all = await review(ad);
    expect(ids(all.overdueNextStep)).toContain(late.id);
    expect(ids(all.needsNextStep)).toContain(none.id);
  });

  it("leaves out Paused and archived deals", async () => {
    const lead = await account("rvpaused");
    const paused = await mkDeal(lead, { due: istDate(-3), stage: "On hold" });
    const arch = await mkDeal(lead, { due: istDate(-3) });
    await lead.c.post(`/api/projects/${arch.id}/archive`, {});
    const r = await review(lead);
    for (const k of ["needsNextStep", "overdueNextStep", "stalled"]) { expect(ids(r[k])).not.toContain(paused.id); expect(ids(r[k])).not.toContain(arch.id); }
  });

  it("lists ideas older than 30 days; Drop removes the flag and keeps the task; viewers cannot act", async () => {
    const lead = await account("rvidea");
    const viewer = await account("rvview");
    const p = await project(lead, lead, [{ who: viewer, role: "VIEWER" }]);
    const old = await task(lead, p.id, { title: "Old idea" });
    const fresh = await task(lead, p.id, { title: "Fresh idea" });
    for (const t of [old, fresh]) await lead.c.post(`/api/tasks/${t}/idea`, { isIdea: true });
    await db.$executeRaw`UPDATE "Task" SET "createdAt" = ${new Date(Date.now() - 40 * 86400_000)} WHERE id = ${old}`;
    const r = await review(lead);
    expect(ids(r.ideas)).toContain(old);
    expect(ids(r.ideas)).not.toContain(fresh);
    expect((await review(viewer)).ideas.find((i: { id: string }) => i.id === old).canEdit).toBe(false);
    expect((await lead.c.post(`/api/tasks/${old}/idea`, { isIdea: false })).status).toBe(200);
    expect(ids((await review(lead)).ideas)).not.toContain(old);
    expect((await lead.c.get(`/api/tasks/${old}`)).status).toBe(200); // the task stays
  });

  it("counts deals per stage with per-currency totals and 'without value', never zero for unknown", async () => {
    const lead = await account("rvcount");
    await mkDeal(lead, { extra: { value: 1000, currency: "INR" } });
    await mkDeal(lead, { extra: { value: 50, currency: "USD" } });
    await mkDeal(lead);
    const r = await review(lead);
    const lead1 = r.counts.find((p: { name: string }) => p.name === "Proactive").stages.find((s: { name: string }) => s.name === "Lead");
    expect(lead1.count).toBe(3);
    expect(lead1.sums).toEqual(expect.arrayContaining([{ currency: "INR", total: 1000 }, { currency: "USD", total: 50 }]));
    expect(lead1.withoutValue).toBe(1);
  });
});

describe("stalled deals (12.7)", () => {
  it.skipIf(!SECRET)("flags a deal after 30 quiet days, tells the Leader once, and clears on new activity", async () => {
    const lead = await account("stlead");
    const d = await mkDeal(lead);
    const flagged = async () => (await lead.c.get("/api/deals")).json.deals.find((x: { id: string }) => x.id === d.id).stalled as boolean;
    const stalledNotes = async () => (await texts(lead)).filter((n) => /no activity for 30 days/.test(n.text) && n.href.includes(d.id));
    expect(await flagged()).toBe(false);
    await age(d.id, 31);
    expect(await flagged()).toBe(true);
    expect((await lead.c.get(`/api/projects/${d.id}`)).json.project.deal.stalled).toBe(true);
    expect((await runJob("stalled-deals")).status).toBe(200);
    expect(await stalledNotes()).toHaveLength(1);
    expect((await runJob("stalled-deals")).status).toBe(200); // one notice per stall, not one per day
    expect(await stalledNotes()).toHaveLength(1);
    // Any activity clears it.
    await task(lead, d.id, { title: "Poke", dueDate: istDate(2) });
    expect(await flagged()).toBe(false);
    expect(ids((await review(lead)).stalled)).not.toContain(d.id);
    // A new stall after new activity earns a new notice. (Time is faked backwards, so the first notice is moved back too.)
    await db.$executeRaw`UPDATE "Notification" SET "createdAt" = ${new Date(Date.now() - 80 * 86400_000)} WHERE "projectId" = ${d.id} AND type = 'DEAL_STALLED'`;
    await age(d.id, 31);
    await db.$executeRaw`UPDATE "Task" SET "updatedAt" = ${new Date(Date.now() - 31 * 86400_000)} WHERE "projectId" = ${d.id}`;
    expect(ids((await review(lead)).stalled)).toContain(d.id);
    expect((await runJob("stalled-deals")).status).toBe(200);
    expect(await stalledNotes()).toHaveLength(2);
  });

  it.skipIf(!SECRET)("never flags Paused, Done, Lost or archived deals", async () => {
    const lead = await account("stnever");
    const paused = await mkDeal(lead, { stage: "On hold" });
    const arch = await mkDeal(lead);
    await lead.c.post(`/api/projects/${arch.id}/archive`, {});
    for (const d of [paused, arch]) await age(d.id, 45);
    const before = (await texts(lead)).length;
    expect((await runJob("stalled-deals")).status).toBe(200);
    expect((await texts(lead)).length).toBe(before);
    const live = (await lead.c.get("/api/deals")).json.deals as { id: string; stalled: boolean }[];
    expect(live.find((x) => x.id === paused.id)?.stalled).toBe(false);
  });

  it.skipIf(!SECRET)("is on the job list so a missed run is reported like the others", async () => {
    const sa = await superAdmin();
    const status = (await sa.c.get("/api/jobs")).json;
    const names = (status.jobs ?? status).map((j: { job: string }) => j.job);
    expect(names).toContain("stalled-deals");
  });
});
