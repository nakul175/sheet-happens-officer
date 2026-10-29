// APL-2741. notifyStalledDeals applies crmProjectWhere for the Leader.
// AC for one real server process per CRM_VISIBLE mode, including 40 concurrent job posts, lives in
// tests/jobs-stalled-crm-server.mode.test.ts and runs in CI via `npm run test:modes`.
// Rows are checked in the test database and on GET /api/notifications. The job sends no email;
// the outbox is checked so a deal name cannot leave that way either. Names are ZZ-TEST.
// qa:TC missing: QA has not assigned TC ids for this story yet.
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
  worldDealIds,
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

type WorldStalledRow = { id: string; recipientId: string; projectId: string | null };

/** Exact DEAL_STALLED set for this test's ZZ-TEST deals; foreign worlds cannot affect it. */
async function worldStalledRows(): Promise<WorldStalledRow[]> {
  return db.notification.findMany({
    where: { type: "DEAL_STALLED", projectId: { in: worldDealIds(world) } },
    select: { id: true, recipientId: true, projectId: true },
    orderBy: [{ projectId: "asc" }, { recipientId: "asc" }, { id: "asc" }],
  });
}

/** APL-2754. A repeat run must leave the exact world-scoped row set unchanged. */
async function expectRepeatLeavesWorldUnchanged() {
  const before = await worldStalledRows();
  await notifyStalledDeals();
  expect(await worldStalledRows()).toEqual(before);
}

function worldRowPairs(rows: WorldStalledRow[]) {
  return rows.map(({ recipientId, projectId }) => ({ recipientId, projectId }));
}

function expectedWorldRowPairs(mode: "all" | "admins") {
  const rows = [
    { recipientId: world.orgAdmin.id, projectId: world.adminDeal.id as string | null },
    { recipientId: world.superLead.id, projectId: world.rootDeal.id as string | null },
  ];
  if (mode === "all") rows.push({ recipientId: world.owner.id, projectId: world.owned.id });
  return rows.sort((a, b) => `${a.projectId}:${a.recipientId}`.localeCompare(`${b.projectId}:${b.recipientId}`));
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

describe("qa:TC missing APL-2741 stalled-deal notices: all/admins cases detect duplicate-notice regressions", () => {
  beforeAll(async () => {
    assertLocalTestDatabase();
    world = await seedStalledWorld();
  }, 60_000);

  afterAll(async () => {
    await cleanupStalledWorld(world);
  });

  it("qa:TC missing AC2: unset preserves today's visibility without claiming independent mutation detection", async () => {
    await clearStalledNotes(world);
    await withMode("unset", async () => {
      expect(crmMode()).toBe("all");
      const ids = await dealIds();
      expect(ids.has(world.owned.id)).toBe(true);
      expect(ids.has(world.adminDeal.id)).toBe(true);
      await notifyStalledDeals();
      expect(worldRowPairs(await worldStalledRows())).toEqual(expectedWorldRowPairs("all"));
    });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC2: all detects duplicate-notice regressions with an exact world-scoped set", async () => {
    await clearStalledNotes(world);
    await withMode("all", async () => {
      expect(crmMode()).toBe("all");
      await notifyStalledDeals();
      expect(worldRowPairs(await worldStalledRows())).toEqual(expectedWorldRowPairs("all"));
      await expectRepeatLeavesWorldUnchanged();
    });
    await expectStalledNotice(world.owner, world.owned, true);
    await expectAllowed(true);
    expectNoDealMail(dealNeedles(world));
  });

  it("qa:TC missing AC1 AC2: admins detects duplicate-notice regressions with an exact world-scoped set", async () => {
    await clearStalledNotes(world);
    await withMode("admins", async () => {
      expect(crmMode()).toBe("admins");
      const ids = await dealIds();
      expect(ids.has(world.owned.id)).toBe(false);
      expect(ids.has(world.adminDeal.id)).toBe(true);
      expect(ids.has(world.rootDeal.id)).toBe(true);
      await notifyStalledDeals();
      expect(worldRowPairs(await worldStalledRows())).toEqual(expectedWorldRowPairs("admins"));
      await expectRepeatLeavesWorldUnchanged();
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
