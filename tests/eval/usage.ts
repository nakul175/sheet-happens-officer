// Usage for this run is stamped feature "eval" in the throwaway database only.
// The column is added here, not by a migration, so production schema and deploys stay as they are.
import { db } from "../../src/lib/db";

export async function ensureFeatureColumn(): Promise<void> {
  await db.$executeRawUnsafe(`ALTER TABLE "ModelUsage" ADD COLUMN IF NOT EXISTS "feature" TEXT`);
}

/** A database timestamp from just before the run, so stamping does not depend on the app clock. */
export async function usageWindowStart(): Promise<Date> {
  const rows = await db.$queryRaw<{ t: Date }[]>`SELECT CURRENT_TIMESTAMP - INTERVAL '5 seconds' AS t`;
  if (!rows[0]?.t) throw new Error("Could not read the database clock.");
  return new Date(rows[0].t);
}

/** Marks ledger rows written during this run. Returns how many rows now say feature eval. */
export async function stampEvalUsage(since: Date): Promise<number> {
  await db.$executeRaw`
    UPDATE "ModelUsage" SET "feature" = 'eval'
    WHERE "createdAt" >= ${since} AND ("feature" IS NULL OR "feature" <> 'eval')
  `;
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM "ModelUsage" WHERE "feature" = 'eval' AND "createdAt" >= ${since}
  `;
  return Number(rows[0]?.n ?? 0);
}
