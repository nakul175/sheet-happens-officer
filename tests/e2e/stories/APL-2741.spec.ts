// APL-2741. The bell renders a stalled-deal notice (deal name and /projects/<id> link).
// These cases read GET /api/notifications, which is the payload the bell paints.
// qa:TC missing: Pam has not assigned TC ids for this story yet.
// ZZ-TEST deals, nakul17+ aliases. The job sends no email; the outbox is still checked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifyStalledDeals } from "@/lib/deals";
import {
  assertLocalTestDatabase,
  cleanupStalledWorld,
  clearStalledNotes,
  dealNeedles,
  expectNoDealMail,
  expectNoDealNotice,
  expectStalledNotice,
  seedStalledWorld,
  type Mode,
  type StalledWorld,
} from "../../stalled-crm-fixture";

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

describe("APL-2741 stalled-deal bell (qa:TC missing)", () => {
  beforeAll(async () => {
    assertLocalTestDatabase();
    world = await seedStalledWorld();
  }, 60_000);

  afterAll(async () => {
    await cleanupStalledWorld(world);
  });

  it("qa:TC missing @AC2 unset: the bell shows today's stalled-deal sentence to the owner and to admins", async () => {
    await clearStalledNotes(world);
    await withMode("unset", async () => { expect((await notifyStalledDeals()).notified).toBeGreaterThanOrEqual(1); });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectStalledNotice(world.orgAdmin, world.adminDeal, true);
    await expectStalledNotice(world.superLead, world.rootDeal, true);
    await expectNoDealNotice(world, world.follower);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing @AC2 CRM_VISIBLE=all: the bell matches unset", async () => {
    await clearStalledNotes(world);
    await withMode("all", async () => { await notifyStalledDeals(); });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectStalledNotice(world.orgAdmin, world.adminDeal, true);
    await expectNoDealNotice(world, world.follower);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing @AC1 admins: a non-admin owner or follower gets no deal name, id or link in the bell", async () => {
    await clearStalledNotes(world);
    await withMode("admins", async () => { await notifyStalledDeals(); });
    await expectNoDealNotice(world, world.owner);
    await expectNoDealNotice(world, world.follower);
    await expectStalledNotice(world.orgAdmin, world.adminDeal, true);
    await expectStalledNotice(world.superLead, world.rootDeal, true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing @AC1 CRM_VISIBLE=off: the bell names no ZZ-TEST stalled deal", async () => {
    await clearStalledNotes(world);
    await withMode("off", async () => {
      expect(await notifyStalledDeals()).toEqual({ stalled: 0, notified: 0, skipped: true });
    });
    for (const who of [world.owner, world.follower, world.orgAdmin, world.superLead]) {
      await expectNoDealNotice(world, who);
    }
    expectNoDealMail(dealNeedles(world));
  });
});
