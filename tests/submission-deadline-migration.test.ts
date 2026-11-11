import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { db } from "@/lib/db";
import { account, BASE, cleanupZz, istDate, superAdmin } from "./helpers";
it("SHO-3054 AC6 reverses/reapplies the expansion transactionally without changing legacy Bid dates or losing timed rows", async () => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)).toBe(true);
  expect(["/sho_test", "/sho_staging"].includes(url.pathname)).toBe(true);
  expect(["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)).toBe(true);
  const owner = await account("zz3054migration"), projects: string[] = [];
  let org = "";
  try {
    const o = await owner.c.post("/api/orgs", { name: `ZZ-TEST 3054 migration ${Date.now()}` });expect(o.status).toBe(201);org=o.json.organisation.id;
    const pipes = (await owner.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
    const p = pipes.find(p => p.key === "DEAL_BID")!;
    const made = await owner.c.post("/api/deals", { name: `ZZ-TEST 3054 migration ${Date.now()}`, organisationId: org, pipelineId: p.id, leaderId: owner.id, whyPursue: "Migration regression", nextStep: { title: "ZZ-TEST next", dueDate: istDate(3) }, submissionDeadline: "2026-11-01", submissionDeadlineTime: "17:30", submissionDeadlineZone: "Asia/Kolkata" });
    expect(made.status).toBe(201);const id = made.json.deal.id as string;projects.push(id);
    const before = await db.dealDetails.findUniqueOrThrow({ where: { projectId: id } });
    const rollback = readFileSync("prisma/rollback/20261029030000_bid_deadline_time.sql", "utf8");
    const guard = rollback.slice(rollback.indexOf("DO $$"), rollback.indexOf("ALTER TABLE"));
    await expect(db.$transaction(async tx => { await tx.$executeRawUnsafe(guard); })).rejects.toThrow(/Timed submission deadlines exist/);
    const stop = new Error("Rollback rehearsal only");
    await expect(db.$transaction(async tx => {
      // DDL is rolled back, not committed; no timed metadata is ever discarded by this rehearsal.
      await tx.$executeRawUnsafe('ALTER TABLE "DealDetails" DROP COLUMN "submissionDeadlineAt", DROP COLUMN "submissionDeadlineZone"');
      const legacy = await tx.$queryRaw<{ submissionDeadline: Date }[]>`SELECT "submissionDeadline" FROM "DealDetails" WHERE "projectId" = ${id}`;
      expect(legacy[0].submissionDeadline.toISOString().slice(0, 10)).toBe("2026-11-01");
      await tx.$executeRawUnsafe('ALTER TABLE "DealDetails" ADD COLUMN "submissionDeadlineAt" TIMESTAMPTZ(3), ADD COLUMN "submissionDeadlineZone" TEXT');
      const readded = await tx.$queryRaw<{ submissionDeadline: Date; submissionDeadlineAt: Date | null }[]>`SELECT "submissionDeadline", "submissionDeadlineAt" FROM "DealDetails" WHERE "projectId" = ${id}`;
      expect(readded[0].submissionDeadline.toISOString().slice(0, 10)).toBe("2026-11-01");expect(readded[0].submissionDeadlineAt).toBeNull();
      throw stop;
    })).rejects.toThrow("Rollback rehearsal only");
    const after = await db.dealDetails.findUniqueOrThrow({ where: { projectId: id } });
    expect(after.submissionDeadline).toEqual(before.submissionDeadline);
    expect(after.submissionDeadlineAt).toEqual(before.submissionDeadlineAt);expect(after.submissionDeadlineZone).toBe(before.submissionDeadlineZone);
  } finally {
    await cleanupZz(projects, [owner]);
    if (org) expect((await (await superAdmin()).c.post(`/api/orgs/${org}/archive`, { archive: true })).status).toBe(200);
  }
}, 180000);
