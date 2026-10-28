// Shared setup for the APL-2741 stalled-deal checks. Names are ZZ-TEST. Addresses are nakul17+ aliases.
// A non-local database is refused. Seeding uses the shared server (CRM_VISIBLE unset) so a deal can be created.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { db } from "../src/lib/db";
import { account, istDate, type Account } from "./helpers";

export type Mode = "unset" | "all" | "admins" | "off";
export type BellItem = { text: string; href: string | null };

export type DealFix = { id: string; name: string; title: string };
export type StalledWorld = {
  tag: string;
  owner: Account;
  follower: Account;
  orgAdmin: Account;
  superLead: Account;
  owned: DealFix;
  adminDeal: DealFix;
  rootDeal: DealFix;
};

const PEOPLE = (world: StalledWorld) => [world.owner, world.follower, world.orgAdmin, world.superLead];
/** One definition of the deals owned by this isolated test world. */
export const worldDeals = (world: StalledWorld) => [world.owned, world.adminDeal, world.rootDeal];

export function assertLocalTestDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required and must point at the local test database");
  let host = "";
  try {
    host = new URL(raw.replace(/^postgres(ql)?:/i, "http:")).hostname;
  } catch {
    throw new Error("DATABASE_URL must point at the local test database");
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Refusing to run: stalled-deal tests use the local test database only");
  }
}

export function stalledTag() {
  return `${Date.now().toString(36)}-${process.pid}`;
}

async function makeDeal(who: Account, name: string, title: string) {
  const pipes = (await who.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const pipe = pipes.find((p) => p.key === "DEAL_PROACTIVE");
  expect(pipe?.id).toBeTruthy();
  const org = await who.c.post("/api/orgs", { name: `ZZ-TEST Org ${name}` });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const made = await who.c.post("/api/deals", {
    name,
    organisationId: org.json.organisation.id,
    pipelineId: pipe!.id,
    leaderId: who.id,
    whyPursue: "ZZ-TEST fit",
    nextStep: { title, dueDate: istDate(14) },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.json.deal.id as string;
}

/** Owner leads one stalled deal. Follower is an editor on every deal. Admin and Super Admin each lead one. */
export async function seedStalledWorld(tag = stalledTag()): Promise<StalledWorld> {
  const owner = await account(`ZZ-TEST owner ${tag}`, `nakul17+zz-2741-${tag}-owner@aplyd.com`);
  const follower = await account(`ZZ-TEST follower ${tag}`, `nakul17+zz-2741-${tag}-follower@aplyd.com`);
  const orgAdmin = await account(`ZZ-TEST admin ${tag}`, `nakul17+zz-2741-${tag}-admin@aplyd.com`);
  const superLead = await account(`ZZ-TEST super ${tag}`, `nakul17+zz-2741-${tag}-super@aplyd.com`);
  await db.user.update({ where: { id: orgAdmin.id }, data: { orgRole: "ADMIN" } });
  await db.user.update({ where: { id: superLead.id }, data: { orgRole: "SUPER_ADMIN" } });

  const owned: DealFix = { id: "", name: `ZZ-TEST Acme renewal ${tag}`, title: `ZZ-TEST Acme kickoff ${tag}` };
  const adminDeal: DealFix = { id: "", name: `ZZ-TEST Admin renewal ${tag}`, title: `ZZ-TEST Admin kickoff ${tag}` };
  const rootDeal: DealFix = { id: "", name: `ZZ-TEST Root renewal ${tag}`, title: `ZZ-TEST Root kickoff ${tag}` };
  owned.id = await makeDeal(owner, owned.name, owned.title);
  adminDeal.id = await makeDeal(orgAdmin, adminDeal.name, adminDeal.title);
  rootDeal.id = await makeDeal(superLead, rootDeal.name, rootDeal.title);

  const world: StalledWorld = { tag, owner, follower, orgAdmin, superLead, owned, adminDeal, rootDeal };
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
  return world;
}

export async function ageDeals(world: StalledWorld) {
  const t = new Date(Date.now() - 31 * 86400_000);
  for (const id of worldDeals(world).map(deal => deal.id)) {
    await db.$executeRaw`UPDATE "Project" SET "createdAt" = ${t}, "stageChangedAt" = ${t} WHERE id = ${id}`;
    await db.$executeRaw`UPDATE "Task" SET "updatedAt" = ${t} WHERE "projectId" = ${id}`;
    await db.$executeRaw`UPDATE "ActionLog" SET "createdAt" = ${t} WHERE "projectId" = ${id}`;
  }
}

export async function clearStalledNotes(world: StalledWorld) {
  await db.notification.deleteMany({ where: { recipientId: { in: PEOPLE(world).map((p) => p.id) } } });
}

export async function storedRows(recipientId: string) {
  return db.notification.findMany({
    where: { recipientId },
    select: { recipientId: true, type: true, actorId: true, taskId: true, projectId: true, data: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function bell(who: Account) {
  const r = await who.c.get("/api/notifications?limit=200");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.items as BellItem[];
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
  await db.notification.deleteMany({ where: { recipientId: { in: PEOPLE(world).map((p) => p.id) } } });
}
