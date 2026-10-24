// APL-2709: the 30-quiet-day parts of APL-2525 AC6, APL-2543 AC1/AC2/AC3/AC5 and APL-2546 AC2.
// Pam left no qa:TC id. Each title says qa:TC missing. An AC number is not a TC id.
// No row is written by this file. Deals, tasks and ideas are made through the HTTP API, and in afterAll the deals, orgs and
// projects are archived and the nakul17+ aliases deactivated, again through the API.
// The product reads "now" at call time (listDeals, dealBlock, pipelineReview, notifyStalledDeals), so each check fakes Date
// in this process only, to exactly 30 days and 1 ms after the activity time the product itself reports. The server's clock is
// never moved. A server-side clock hook for the Playwright screens is APL-2757.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { dealBlock, listDeals, notifyStalledDeals } from "../src/lib/deals";
import { pipelineReview } from "../src/lib/review";
import type { Actor } from "../src/lib/access";
import { account, istDate, superAdmin, withVersion, type Account } from "./helpers";

const DAY = 86_400_000;
const STALL = 30 * DAY;
let seq = 0;
const zz = (label: string) => `ZZ-TEST 2709 ${label} ${Date.now()}-${seq++}`;
const cleanups: (() => Promise<unknown>)[] = [];
const aliases: string[] = [];
let admin: Account | undefined;

/** A run-unique nakul17+ alias with a ZZ-TEST name, deactivated in afterAll. */
async function alias(label: string) {
  const a = await account(`ZZ-TEST 2709 ${label}`, `nakul17+zz-2709-${label}-${Date.now()}-${seq++}@aplyd.com`);
  aliases.push(a.id);
  return a;
}

beforeAll(() => {
  // notifyStalledDeals looks at every deal it can see, so this file only runs against a local test database.
  let host = "";
  try { host = new URL(process.env.DATABASE_URL ?? "").hostname; } catch { /* not a URL */ }
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error("stall-clock-2709 needs DATABASE_URL on localhost (a local test database).");
});

/** Deactivate one alias. A Leader is refused (409 with `leads`), so each of those projects goes to the admin first. */
async function retire(sa: Account, userId: string) {
  const off = () => sa.c.post(`/api/team/${userId}/deactivate`, { reassign: "leaders" });
  let r = await off();
  if (r.status === 409 && Array.isArray(r.json?.leads)) {
    for (const lead of r.json.leads as { id: string }[]) {
      const archived = !!(await sa.c.get(`/api/projects/${lead.id}`)).json?.project?.archived;
      if (archived) expect((await sa.c.post(`/api/projects/${lead.id}/unarchive`)).status).toBeLessThan(300);
      expect([201, 409]).toContain((await sa.c.post(`/api/projects/${lead.id}/members`, { userId: sa.id, role: "EDITOR" })).status);
      expect((await sa.c.post(`/api/projects/${lead.id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" })).status).toBe(200);
      if (archived) expect((await sa.c.post(`/api/projects/${lead.id}/archive`)).status).toBeLessThan(300);
    }
    r = await off();
  }
  expect(r.status, `deactivate ${userId}: ${JSON.stringify(r.json)}`).toBe(200);
}

afterAll(async () => {
  if (!admin) return;
  for (const id of aliases) await retire(admin, id);
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* archive is best effort */ } }
});

async function actor(a: Account): Promise<Actor> {
  const me = await a.c.get("/api/auth/me");
  expect(me.status).toBe(200);
  return { id: me.json.user.id, orgRole: me.json.user.orgRole, name: me.json.user.name };
}

/** Run `fn` with Date faked to `now` in this process. */
async function at<T>(now: number, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  try { return await fn(); } finally { vi.useRealTimers(); }
}

async function pipelines(a: Account) {
  return (await a.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string; stages: { id: string; name: string }[] }[];
}

async function makeDeal(sa: Account, leaderId: string, label: string) {
  const org = await sa.c.post("/api/orgs", { name: zz(`org ${label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  cleanups.push(() => sa.c.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const pro = (await pipelines(sa)).find((p) => p.key === "DEAL_PROACTIVE")!;
  const name = zz(`deal ${label}`);
  const r = await sa.c.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pro.id, leaderId, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz(`step ${label}`), dueDate: istDate(5) },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  cleanups.push(() => sa.c.post(`/api/projects/${id}/archive`));
  return { id, name };
}

/** The deal's last activity, as the product reports it on the real clock. */
async function lastActivity(who: Actor, id: string, archived = false) {
  const row = (await listDeals(who, { archived })).find((d) => d.id === id);
  expect(row, `deal ${id} is listed`).toBeTruthy();
  return Date.parse(row!.lastActivity);
}

const stalledNotes = async (who: Account, dealId: string) =>
  ((await who.c.get("/api/notifications?limit=200")).json.items as { text: string; href: string }[])
    .filter((n) => n.href.includes(dealId) && /no activity for 30 days/.test(n.text));

it("APL-2525 AC6 (30 quiet days, in-process clock): a working deal with no logged activity for 30 days notifies its Leader once qa:TC missing", async () => {
  const sa = (admin ??= await superAdmin());
  const leader = await alias("stall-leader");
  const d = await makeDeal(sa, leader.id, "e12 quiet");
  const lead = await actor(leader);
  const quietPast = (await lastActivity(lead, d.id)) + STALL + 1;
  await at(quietPast, async () => {
    expect((await listDeals(lead)).find((x) => x.id === d.id)?.stalled, "the Leader's list flags the deal").toBe(true);
    await notifyStalledDeals();
  });
  expect(await stalledNotes(leader, d.id)).toHaveLength(1);
  await at(quietPast, () => notifyStalledDeals());
  expect(await stalledNotes(leader, d.id), "a second run sends no second notice").toHaveLength(1);
});

it("APL-2543 AC1 (30 quiet days, in-process clock): the list, the deal block and the review flag the deal Stalled, and a logged change counts as activity qa:TC missing", async () => {
  const sa = (admin ??= await superAdmin());
  const me = await actor(sa);
  const d = await makeDeal(sa, sa.id, "stalled flag");
  const quietPast = (await lastActivity(me, d.id)) + STALL + 1;
  await at(quietPast, async () => {
    expect((await listDeals(me)).find((x) => x.id === d.id)?.stalled).toBe(true);
    expect((await dealBlock(d.id))?.stalled).toBe(true);
    expect((await pipelineReview(me)).stalled.some((x) => x.id === d.id)).toBe(true);
  });
  expect((await sa.c.post(`/api/projects/${d.id}/tasks`, { title: zz("logged change") })).status).toBe(201);
  await at(quietPast, async () => {
    expect((await listDeals(me)).find((x) => x.id === d.id)?.stalled, "the new task is activity, so the flag clears").toBe(false);
    expect((await dealBlock(d.id))?.stalled).toBe(false);
  });
});

it("APL-2543 AC2 (30 quiet days, in-process clock): any later activity, such as a stage move, clears the Stalled flag qa:TC missing", async () => {
  const sa = (admin ??= await superAdmin());
  const me = await actor(sa);
  const d = await makeDeal(sa, sa.id, "stalled clear");
  const conversation = (await pipelines(sa)).find((p) => p.key === "DEAL_PROACTIVE")!.stages.find((s) => s.name === "Conversation")!;
  const quietPast = (await lastActivity(me, d.id)) + STALL + 1;
  await at(quietPast, async () => expect((await listDeals(me)).find((x) => x.id === d.id)?.stalled).toBe(true));
  expect((await sa.c.post(`/api/projects/${d.id}/stage`, { stageId: conversation.id })).status).toBe(200);
  await at(quietPast, async () => {
    expect((await listDeals(me)).find((x) => x.id === d.id)?.stalled).toBe(false);
    expect((await pipelineReview(me)).stalled.some((x) => x.id === d.id)).toBe(false);
  });
});

it("APL-2543 AC3 (30 quiet days, in-process clock): one in-app notice per stall, and a new one only after new activity and 30 more quiet days qa:TC missing", async () => {
  const sa = (admin ??= await superAdmin());
  const me = await actor(sa);
  const d = await makeDeal(sa, sa.id, "stalled notice");
  const firstQuiet = (await lastActivity(me, d.id)) + STALL + 1;
  await at(firstQuiet, () => notifyStalledDeals());
  expect(await stalledNotes(sa, d.id)).toHaveLength(1);
  await at(firstQuiet, () => notifyStalledDeals());
  expect(await stalledNotes(sa, d.id), "the same stall is not told twice").toHaveLength(1);
  expect((await sa.c.post(`/api/projects/${d.id}/tasks`, { title: zz("new activity") })).status).toBe(201);
  await at(firstQuiet, () => notifyStalledDeals());
  expect(await stalledNotes(sa, d.id), "new activity, but not yet 30 more quiet days").toHaveLength(1);
  const secondQuiet = (await lastActivity(me, d.id)) + STALL + 1;
  await at(secondQuiet, () => notifyStalledDeals());
  expect(await stalledNotes(sa, d.id), "30 quiet days after the new activity").toHaveLength(2);
});

it("APL-2543 AC5 (30 quiet days, in-process clock): archived, Paused, Done and Lost deals are never flagged qa:TC missing", async () => {
  const sa = (admin ??= await superAdmin());
  const me = await actor(sa);
  const stages = (await pipelines(sa)).find((p) => p.key === "DEAL_PROACTIVE")!.stages;
  const stage = (name: string) => stages.find((s) => s.name === name)!.id;
  const control = await makeDeal(sa, sa.id, "never control");
  const hold = await makeDeal(sa, sa.id, "never hold");
  const won = await makeDeal(sa, sa.id, "never won");
  const lost = await makeDeal(sa, sa.id, "never lost");
  const archived = await makeDeal(sa, sa.id, "never archived");
  expect((await sa.c.post(`/api/projects/${hold.id}/stage`, { stageId: stage("On hold"), reason: "ZZ-TEST pause" })).status).toBe(200);
  for (const deal of [won, lost]) {
    const step = (await sa.c.get(`/api/projects/${deal.id}`)).json.project.deal.nextStep.id as string;
    expect((await sa.c.post(`/api/tasks/${step}/complete`, await withVersion(sa, step))).status).toBe(200);
  }
  expect((await sa.c.post(`/api/projects/${won.id}/stage`, { stageId: stage("Won") })).status).toBe(200);
  expect((await sa.c.post(`/api/projects/${lost.id}/stage`, { stageId: stage("Lost"), reason: "ZZ-TEST lost" })).status).toBe(200);
  expect((await sa.c.post(`/api/projects/${archived.id}/archive`)).status).toBeLessThan(300);
  const last = Math.max(
    ...(await Promise.all([hold, won, lost].map((x) => lastActivity(me, x.id)))),
    await lastActivity(me, archived.id, true),
  );
  const quietPast = last + STALL + 1;
  await at(quietPast, async () => {
    const live = await listDeals(me);
    expect(live.find((x) => x.id === control.id)?.stalled, "the clock is far enough on: a working deal is flagged").toBe(true);
    for (const x of [hold, won, lost]) expect(live.find((row) => row.id === x.id)?.stalled, x.name).toBe(false);
    expect((await listDeals(me, { archived: true })).find((row) => row.id === archived.id)?.stalled).toBe(false);
    await notifyStalledDeals();
  });
  expect(await stalledNotes(sa, control.id)).toHaveLength(1);
  for (const x of [hold, won, lost, archived]) expect(await stalledNotes(sa, x.id), x.name).toEqual([]);
});

it("APL-2546 AC2 (30 days later, in-process clock): Drop removes the Idea flag and the task stays qa:TC missing", async () => {
  const sa = (admin ??= await superAdmin());
  const viewer = await alias("idea-viewer");
  const me = await actor(sa);
  const p = await sa.c.post("/api/projects", { name: zz("review drop"), leaderId: sa.id });
  expect(p.status).toBe(201);
  const projectId = p.json.project.id as string;
  cleanups.push(() => sa.c.post(`/api/projects/${projectId}/archive`));
  expect((await sa.c.post(`/api/projects/${projectId}/members`, { userId: viewer.id, role: "VIEWER" })).status).toBe(201);
  const title = zz("old idea");
  const t = await sa.c.post(`/api/projects/${projectId}/tasks`, { title, dueDate: istDate(6), assigneeId: sa.id });
  expect(t.status, JSON.stringify(t.json)).toBe(201);
  const id = t.json.task.id as string;
  // The task API does not return createdAt. The server shares this host's clock, so the moment the create
  // returned is an upper bound for it, and the review row below confirms the stored value.
  const createdBy = Date.now();
  expect((await sa.c.post(`/api/tasks/${id}/idea`, { isIdea: true })).status).toBe(200);
  const view = await actor(viewer);
  const monthOn = createdBy + STALL + 1;
  await at(monthOn, async () => {
    const row = (await pipelineReview(me)).ideas.find((i) => i.id === id);
    expect(row?.canEdit, "listed for the Admin, who may Drop it").toBe(true);
    expect(Date.parse(row!.createdAt)).toBeLessThanOrEqual(createdBy);
    expect((await pipelineReview(view)).ideas.find((i) => i.id === id)?.canEdit, "a Viewer is not offered Drop").toBe(false);
  });
  // The review's Drop button posts exactly this (src/app/(app)/review/ReviewView.tsx).
  expect((await sa.c.post(`/api/tasks/${id}/idea`, { isIdea: false })).status).toBe(200);
  await at(monthOn, async () => expect((await pipelineReview(me)).ideas.some((i) => i.id === id)).toBe(false));
  const after = await sa.c.get(`/api/tasks/${id}`);
  expect(after.status).toBe(200);
  expect(after.json.task.isIdea).toBe(false);
  expect(after.json.task.title).toBe(title);
});
