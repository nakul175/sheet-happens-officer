// APL-2741. notifyStalledDeals applies crmProjectWhere for the Leader.
// AC for one real server process per CRM_VISIBLE mode, including 40 concurrent job posts, lives in
// tests/jobs-stalled-crm-server.test.ts and runs in CI via `npm run test:stalled-modes`.
// Rows are checked in the test database and on GET /api/notifications. The job sends no email;
// the outbox is checked so a deal name cannot leave that way either. Names are ZZ-TEST.
//
// qa:TC-APL2741-c1a1d001@v1 admins / non-admin owner and follower
// qa:TC-APL2741-c2ad0001@v1 admins / admin and super admin
// qa:TC-APL2741-c2ee0001@v1 unset
// qa:TC-APL2741-c2a11001@v1 all
// qa:TC-APL2741-c1ff0001@v1 off
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

describe("stalled-deal notices respect CRM_VISIBLE (APL-2741)", () => {
  beforeAll(async () => {
    assertLocalTestDatabase();
    world = await seedStalledWorld();
  }, 60_000);

  afterAll(async () => {
    await cleanupStalledWorld(world);
  });

  it("qa:TC-APL2741-c2ee0001@v1 unset matches today: the owner, admin and super admin are told, the follower is not", async () => {
    await clearStalledNotes(world);
    await withMode("unset", async () => {
      expect(crmMode()).toBe("all");
      const ids = await dealIds();
      expect(ids.has(world.owned.id)).toBe(true);
      expect(ids.has(world.adminDeal.id)).toBe(true);
      const first = await notifyStalledDeals();
      expect(first.notified).toBeGreaterThanOrEqual(3);
      const second = await notifyStalledDeals();
      expect(second.notified).toBeGreaterThanOrEqual(0);
    });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC-APL2741-c2a11001@v1 CRM_VISIBLE=all matches today", async () => {
    await clearStalledNotes(world);
    await withMode("all", async () => {
      expect(crmMode()).toBe("all");
      expect((await notifyStalledDeals()).notified).toBeGreaterThanOrEqual(3);
      expect((await notifyStalledDeals()).notified).toBe(0);
    });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC-APL2741-c1a1d001@v1 qa:TC-APL2741-c2ad0001@v1 admins: a non-admin owner or follower gets no deal notice, and admins still do", async () => {
    await clearStalledNotes(world);
    await withMode("admins", async () => {
      expect(crmMode()).toBe("admins");
      const ids = await dealIds();
      expect(ids.has(world.owned.id)).toBe(false);
      expect(ids.has(world.adminDeal.id)).toBe(true);
      expect(ids.has(world.rootDeal.id)).toBe(true);
      expect((await notifyStalledDeals()).notified).toBeGreaterThanOrEqual(2);
      expect((await notifyStalledDeals()).notified).toBe(0);
    });
    await expectNoDealNotice(world, world.owner);
    await expectNoDealNotice(world, world.follower);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC-APL2741-c1ff0001@v1 off: nobody is told, and the filter matches no ZZ-TEST deal", async () => {
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
