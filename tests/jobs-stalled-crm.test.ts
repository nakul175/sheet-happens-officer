// APL-2741. notifyStalledDeals applies crmProjectWhere for the Leader.
// AC for one real server process per CRM_VISIBLE mode, including 40 concurrent job posts, lives in
// tests/jobs-stalled-crm-server.test.ts and runs in CI via `npm run test:stalled-modes`.
// Rows are checked in the test database and on GET /api/notifications. The job sends no email;
// the outbox is checked so a deal name cannot leave that way either. Names are ZZ-TEST.
// qa:TC missing: QA has not assigned TC ids for this story yet.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crmMode } from "../src/lib/crm";
import { notifyStalledDeals, stalledDealWhere } from "../src/lib/deals";
import { db } from "../src/lib/db";
import {
  assertLocalTestDatabase,
  bell,
  cleanupStalledWorld,
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

/** Exact DEAL_STALLED rows on this test's ZZ-TEST deals. Foreign worlds never affect these assertions. */
async function worldStalledRows() {
  const projectId = { in: worldDeals(world).map(deal => deal.id) };
  return db.notification.findMany({ where: { type: "DEAL_STALLED", projectId }, orderBy: { id: "asc" } });
}

/** SHO-2903: scoped first-run count and exact second-run snapshot.
 * M1 detection comes from the all/admins cases, not from the unset assertion alone. */
async function notifyWorldDeals() {
  const before = await worldStalledRows();
  await notifyStalledDeals();
  const after = await worldStalledRows();
  return { notified: after.length - before.length, before, after };
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
  beforeEach(async () => {
    assertLocalTestDatabase();
    world = undefined!;
    world = await seedStalledWorld();
  }, 60_000);

  afterEach(async () => {
    await cleanupStalledWorld(world);
  });

  it("qa:TC missing AC2: unset matches today: the owner, admin and super admin are told, the follower is not", async () => {
    await withMode("unset", async () => {
      expect(crmMode()).toBe("all");
      const ids = await dealIds();
      expect(ids.has(world.owned.id)).toBe(true);
      expect(ids.has(world.adminDeal.id)).toBe(true);
      const first = await notifyWorldDeals();
      expect(first.notified).toBeGreaterThanOrEqual(3);
      const second = await notifyWorldDeals();
      expect(second.after).toEqual(second.before); // exact rows: additions/removals cannot cancel out
    });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC2: all preserves exact world notices on a second run (M1 detection)", async () => {
    await withMode("all", async () => {
      expect(crmMode()).toBe("all");
      expect((await notifyWorldDeals()).notified).toBeGreaterThanOrEqual(3);
      const second = await notifyWorldDeals();
      expect(second.after).toEqual(second.before); // exact rows: additions/removals cannot cancel out
    });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC1 AC2: admins hides non-admin deals and preserves exact world notices on a second run (M1 detection)", async () => {
    await withMode("admins", async () => {
      expect(crmMode()).toBe("admins");
      const ids = await dealIds();
      expect(ids.has(world.owned.id)).toBe(false);
      expect(ids.has(world.adminDeal.id)).toBe(true);
      expect(ids.has(world.rootDeal.id)).toBe(true);
      expect((await notifyWorldDeals()).notified).toBeGreaterThanOrEqual(2);
      const second = await notifyWorldDeals();
      expect(second.after).toEqual(second.before); // exact rows: additions/removals cannot cancel out
    });
    await expectNoDealNotice(world, world.owner);
    await expectNoDealNotice(world, world.follower);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC1: off: nobody is told, and the filter matches no ZZ-TEST deal", async () => {
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
