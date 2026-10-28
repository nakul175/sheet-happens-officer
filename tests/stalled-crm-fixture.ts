// Shared setup for the APL-2741 stalled-deal checks. Names are ZZ-TEST. Addresses are nakul17+ aliases.
// A non-local database is refused. Seeding uses the shared server (CRM_VISIBLE unset) so a deal can be created.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { db } from "../src/lib/db";
import { account, istDate, superAdmin, type Account } from "./helpers";

import { ageLocalStalledDeals, assertStalledFixtureTarget } from "./local-stalled-clock-2902";
import { cleanupReminderResources, reminderResources, type ReminderResources } from "./reminder-cleanup-2751";

export type Mode = "unset" | "all" | "admins" | "off";
export type BellItem = { text: string; href: string | null };

export type DealFix = { id: string; name: string; title: string };
export type StalledWorld = {
  tag: string;
  resources: ReminderResources;
  setupNoticeIds: Set<string>;
  owner: Account;
  follower: Account;
  orgAdmin: Account;
  superLead: Account;
  owned: DealFix;
  adminDeal: DealFix;
  rootDeal: DealFix;
};

const setupByPerson = new Map<string, Set<string>>();
const PEOPLE = (world: StalledWorld) => [world.owner, world.follower, world.orgAdmin, world.superLead];
/** One definition of the deals owned by this isolated test world. */
export const worldDeals = (world: StalledWorld) => [world.owned, world.adminDeal, world.rootDeal];

export const assertLocalTestDatabase = assertStalledFixtureTarget;

export function stalledTag() {
  return `${Date.now().toString(36)}-${process.pid}`;
}

async function makeDeal(who: Account, name: string, title: string, resources: ReminderResources) {
  const pipes = (await who.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const pipe = pipes.find((p) => p.key === "DEAL_PROACTIVE");
  expect(pipe?.id).toBeTruthy();
  const org = await who.c.post("/api/orgs", { name: `ZZ-TEST Org ${name}` });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  resources.organisations.push({ id: org.json.organisation.id, archived: false });
  const made = await who.c.post("/api/deals", {
    name,
    organisationId: org.json.organisation.id,
    pipelineId: pipe!.id,
    leaderId: who.id,
    whyPursue: "ZZ-TEST fit",
    nextStep: { title, dueDate: istDate(14) },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  resources.projects.push({ id: made.json.deal.id, leaderId: who.id, archived: false });
  return made.json.deal.id as string;
}

/** Owner leads one stalled deal. Follower is an editor on every deal. Admin and Super Admin each lead one. */
export async function seedStalledWorld(tag = stalledTag()): Promise<StalledWorld> {
  assertStalledFixtureTarget();
  const resources = reminderResources();
  const root = await superAdmin();
  try {
    const owner = await account(`ZZ-TEST owner ${tag}`, `nakul17+zz-2741-${tag}-owner@aplyd.com`);
    resources.people.push({ id: owner.id, deactivated: false });
    const follower = await account(`ZZ-TEST follower ${tag}`, `nakul17+zz-2741-${tag}-follower@aplyd.com`);
    resources.people.push({ id: follower.id, deactivated: false });
    const orgAdmin = await account(`ZZ-TEST admin ${tag}`, `nakul17+zz-2741-${tag}-admin@aplyd.com`);
    resources.people.push({ id: orgAdmin.id, deactivated: false });
    // Super Admin is provisioned by server configuration, never by the Team API.
    // Reuse the existing CI bootstrap account; it is not a run-owned person to deactivate.
    const superLead = root;
    expect((await root.c.patch(`/api/team/${orgAdmin.id}`, { orgRole: "ADMIN" })).status).toBe(200);

    const owned: DealFix = { id: "", name: `ZZ-TEST Acme renewal ${tag}`, title: `ZZ-TEST Acme kickoff ${tag}` };
    const adminDeal: DealFix = { id: "", name: `ZZ-TEST Admin renewal ${tag}`, title: `ZZ-TEST Admin kickoff ${tag}` };
    const rootDeal: DealFix = { id: "", name: `ZZ-TEST Root renewal ${tag}`, title: `ZZ-TEST Root kickoff ${tag}` };
    owned.id = await makeDeal(owner, owned.name, owned.title, resources);
    adminDeal.id = await makeDeal(orgAdmin, adminDeal.name, adminDeal.title, resources);
    rootDeal.id = await makeDeal(superLead, rootDeal.name, rootDeal.title, resources);

    const world: StalledWorld = { tag, resources, setupNoticeIds: new Set(), owner, follower, orgAdmin, superLead, owned, adminDeal, rootDeal };
    // Follower is an editor on every stalled deal. The owner also follows the two deals they do not lead.
    const adds: { leader: Account; dealId: string; userId: string }[] = [
      { leader: owner, dealId: owned.id, userId: follower.id },
      { leader: orgAdmin, dealId: adminDeal.id, userId: follower.id },
      { leader: superLead, dealId: rootDeal.id, userId: follower.id },
      { leader: orgAdmin, dealId: adminDeal.id, userId: owner.id },
      { leader: superLead, dealId: rootDeal.id, userId: owner.id },
    ];
    for (const add of adds) {
      const r = await add.leader.c.post(`/api/projects/${add.dealId}/members`, { userId: add.userId, role: "EDITOR" });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    await ageDeals(world);
    const setup = await db.notification.findMany({ where: { recipientId: { in: PEOPLE(world).map(p => p.id) } }, select: { id: true } });
    world.setupNoticeIds = new Set(setup.map(n => n.id));
    for (const person of PEOPLE(world)) setupByPerson.set(person.id, world.setupNoticeIds);
    return world;
  } catch (error) {
    try { await cleanupReminderResources(root.id, (p, body) => root.c.post(p, body), resources); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Stalled fixture setup and cleanup failed"); }
    throw error;
  }
}

export async function ageDeals(world: StalledWorld) {
  await ageLocalStalledDeals(worldDeals(world).map(deal => deal.id), world.tag);
}

export async function storedRows(recipientId: string) {
  return db.notification.findMany({
    where: { recipientId, id: { notIn: [...(setupByPerson.get(recipientId) ?? [])] } },
    select: { recipientId: true, type: true, actorId: true, taskId: true, projectId: true, data: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function bell(who: Account) {
  const r = await who.c.get("/api/notifications?limit=200");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (r.json.items as (BellItem & { id: string })[]).filter(item => !setupByPerson.get(who.id)?.has(item.id));
}

export function dealNeedles(world: StalledWorld) {
  const deals = worldDeals(world);
  const needles: string[] = [];
  for (const deal of deals) {
    needles.push(deal.name, deal.title, deal.id, `/projects/${deal.id}`);
  }
  return needles;
}

/** No stored row and no bell item carries a deal name, task title, id or link. */
export async function expectNoDealNotice(world: StalledWorld, who: Account) {
  const rows = await storedRows(who.id);
  const blob = JSON.stringify(rows);
  const items = JSON.stringify(await bell(who));
  for (const needle of dealNeedles(world)) {
    expect(blob, `${who.email} row ${needle}`).not.toContain(needle);
    expect(items, `${who.email} bell ${needle}`).not.toContain(needle);
  }
  expect(rows.filter((row) => row.type === "DEAL_STALLED")).toEqual([]);
}

/** The row and the bell sentence the job writes today: deal name, project link, no task title. */
export async function expectStalledNotice(who: Account, deal: DealFix, exact: boolean) {
  const rows = await storedRows(who.id);
  const mine = rows.filter((row) => row.type === "DEAL_STALLED" && row.projectId === deal.id);
  expect(mine.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(rows).toEqual(mine);
  if (exact) expect(mine).toHaveLength(1);
  expect(mine[0]).toEqual({
    recipientId: who.id,
    type: "DEAL_STALLED",
    actorId: null,
    taskId: null,
    projectId: deal.id,
    data: { project: deal.name },
  });
  const body = JSON.stringify(rows);
  expect(body).not.toContain(deal.title);
  const items = (await bell(who)).filter((item) => item.href === `/projects/${deal.id}`);
  expect(items.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(items).toHaveLength(1);
  expect(items[0]?.text).toBe(`"${deal.name}" has had no activity for 30 days.`);
  expect(items[0]?.text).not.toContain(deal.title);
}

export function expectNoDealMail(needles: string[]) {
  const dir = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { files = []; }
  for (const file of files) {
    const text = readFileSync(path.join(dir, file), "utf8");
    for (const needle of needles) {
      expect(text.includes(needle), `email names ${needle}`).toBe(false);
    }
  }
}

export async function cleanupStalledWorld(world: StalledWorld | undefined) {
  if (!world) return;
  assertStalledFixtureTarget();
  const root = await superAdmin();
  await cleanupReminderResources(root.id, (p, body) => root.c.post(p, body), world.resources);
  for (const person of PEOPLE(world)) setupByPerson.delete(person.id);
  const projects = await db.project.findMany({ where: { id: { in: worldDeals(world).map(p => p.id) } }, select: { archivedAt: true } });
  const people = await db.user.findMany({ where: { id: { in: world.resources.people.map(p => p.id) } }, select: { deactivatedAt: true } });
  expect(projects).toHaveLength(3);
  expect(people).toHaveLength(3);
  expect(projects.every(p => p.archivedAt !== null)).toBe(true);
  expect(people.every(p => p.deactivatedAt !== null)).toBe(true);
  const organisations = await db.organisation.findMany({ where: { id: { in: world.resources.organisations.map(org => org.id) } }, select: { archivedAt: true } });
  expect(organisations).toHaveLength(3);
  expect(organisations.every(org => org.archivedAt !== null)).toBe(true);
}
