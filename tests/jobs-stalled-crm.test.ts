// APL-2741. notifyStalledDeals applies crmProjectWhere for the Leader.
// AC for one real server process per CRM_VISIBLE mode, including 40 concurrent job posts, lives in
// tests/jobs-stalled-crm-server.test.ts and runs in CI via `npm run test:stalled-modes`.
// Rows are checked in the test database and on GET /api/notifications. The job sends no email;
// the outbox is checked so a deal name cannot leave that way either. Names are ZZ-TEST.
// qa:TC missing: QA has not assigned TC ids for this story yet.
// APL-2754 (SHO-2903), detection attribution: main already went red under M1 (the already-notified check at
// src/lib/deals.ts:616 removed) through the all and admins cases, whose second run asserted the job's global
// notified count was 0. The unset case's second-run assertion on main was `toBeGreaterThanOrEqual(0)`, which
// proves nothing, so it added no detection. It is not the origin of the detection now either: the all and
// admins second-run assertions are the ones that fail under M1 both before and after this follow-up.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crmMode } from "../src/lib/crm";
import { notifyStalledDeals, stalledDealWhere } from "../src/lib/deals";
import { db } from "../src/lib/db";
import {
  assertLocalTestDatabase,
  bell,
  cleanupStalledWorld,
  clearStalledNotes,
  dealNeedles,
  expectNoDealMail,
  expectNoDealNotice,
  expectStalledNotice,
  seedStalledWorld,
  storedRows,
  worldDeals,
  type Mode,
  type StalledWorld,
} from "./stalled-crm-fixture";

let world: StalledWorld;

async function withMode(mode: Mode, fn: () => Promise<void>) {
  const prev = process.env.CRM_VISIBLE;
  if (mode === "unset") delete process.env.CRM_VISIBLE;
  else process.env.CRM_VISIBLE = mode;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = prev;
  }
}

async function dealIds() {
  const rows = await db.project.findMany({ where: stalledDealWhere(), select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

/** The three ZZ-TEST deal ids, from the fixture's one definition (APL-2754 D4). */
function worldDealIds() {
  return worldDeals(world).map((deal) => deal.id);
}

/** The exact set of DEAL_STALLED rows on this world's deals. A count would let an add and a remove cancel (D2). */
async function worldStalledIds() {
  const rows = await db.notification.findMany({
    where: { type: "DEAL_STALLED", projectId: { in: worldDealIds() } },
    select: { id: true },
  });
  return rows.map((row) => row.id).sort();
}

/**
 * APL-2754. One job run, reported as the change to this world's notice set: what it added and what it removed.
 * The job's own `notified` is global, so the assertions below read `added` instead of it (D3).
 */
async function runJob() {
  const before = await worldStalledIds();
  const result = await notifyStalledDeals();
  const after = await worldStalledIds();
  return {
    ...result,
    before,
    after,
    added: after.filter((id) => !before.includes(id)),
    removed: before.filter((id) => !after.includes(id)),
  };
}

/** Allowed leaders keep today's notice. A follower, and any other deal, stays out of their bell. */
async function expectAllowed(exact: boolean) {
  await expectStalledNotice(world.orgAdmin, world.adminDeal, exact);
  await expectStalledNotice(world.superLead, world.rootDeal, exact);
  for (const who of [world.orgAdmin, world.superLead]) {
    const body = JSON.stringify(await bell(who)) + JSON.stringify(await storedRows(who.id));
    expect(body).not.toContain(world.owned.name);
    expect(body).not.toContain(world.owned.id);
  }
  await expectNoDealNotice(world, world.follower);
}

describe("qa:TC missing APL-2741 stalled-deal notices respect CRM_VISIBLE", () => {
  beforeAll(async () => {
    assertLocalTestDatabase();
    world = await seedStalledWorld();
  }, 60_000);

  afterAll(async () => {
    await cleanupStalledWorld(world);
  });

  it("qa:TC missing AC2: unset matches today: the owner, admin and super admin are told, the follower is not", async () => {
    await clearStalledNotes(world);
    await withMode("unset", async () => {
      expect(crmMode()).toBe("all");
      const ids = await dealIds();
      expect(ids.has(world.owned.id)).toBe(true);
      expect(ids.has(world.adminDeal.id)).toBe(true);
      const first = await runJob();
      expect(first.added.length).toBeGreaterThanOrEqual(3);
      const second = await runJob();
      expect(second.added).toEqual([]);
      expect(second.after).toEqual(second.before);
    });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC2: CRM_VISIBLE=all matches today", async () => {
    await clearStalledNotes(world);
    await withMode("all", async () => {
      expect(crmMode()).toBe("all");
      const first = await runJob();
      expect(first.added.length).toBeGreaterThanOrEqual(3);
      const second = await runJob();
      expect(second.added).toEqual([]);
      expect(second.after).toEqual(second.before);
    });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC1 AC2: admins: a non-admin owner or follower gets no deal notice, and admins still do", async () => {
    await clearStalledNotes(world);
    await withMode("admins", async () => {
      expect(crmMode()).toBe("admins");
      const ids = await dealIds();
      expect(ids.has(world.owned.id)).toBe(false);
      expect(ids.has(world.adminDeal.id)).toBe(true);
      expect(ids.has(world.rootDeal.id)).toBe(true);
      const first = await runJob();
      expect(first.added.length).toBeGreaterThanOrEqual(2);
      const second = await runJob();
      expect(second.added).toEqual([]);
      expect(second.after).toEqual(second.before);
    });
    await expectNoDealNotice(world, world.owner);
    await expectNoDealNotice(world, world.follower);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC1: off: nobody is told, and the filter matches no ZZ-TEST deal", async () => {
    await clearStalledNotes(world);
    await withMode("off", async () => {
      expect(crmMode()).toBe("off");
      expect(await notifyStalledDeals()).toEqual({ stalled: 0, notified: 0, skipped: true });
      const ids = await dealIds();
      expect(ids.has(world.owned.id)).toBe(false);
      expect(ids.has(world.adminDeal.id)).toBe(false);
      expect(ids.has(world.rootDeal.id)).toBe(false);
    });
    for (const who of [world.owner, world.follower, world.orgAdmin, world.superLead]) {
      await expectNoDealNotice(world, who);
    }
    expectNoDealMail(dealNeedles(world));
  });
});
