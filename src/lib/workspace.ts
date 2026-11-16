import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/http';

/** SHO is one organisation per deployment (owner decision, 3 Nov 2026).
 * Fail closed on ambiguous storage; never pick the oldest or merge/delete data.
 */
export async function singleWorkspace(tx: Prisma.TransactionClient = db) {
  const rows = await tx.workspace.findMany({ take: 2, select: { id: true } });
  if (rows.length !== 1) throw new ApiError(503, 'Workspace configuration requires operator review.');
  return rows[0];
}

export async function assertWorkspaceUser(workspaceId: string, tx: Prisma.TransactionClient = db) {
  if ((await singleWorkspace(tx)).id !== workspaceId) throw new ApiError(503, 'Workspace configuration requires operator review.');
}

/** Serialize the empty-database bootstrap across workers, without a migration. */
export async function getOrCreateWorkspace() {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_catalog.pg_advisory_xact_lock(30581103)`;
    const rows = await tx.workspace.findMany({ take: 2, select: { id: true } });
    if (rows.length > 1) throw new ApiError(503, 'Workspace configuration requires operator review.');
    return rows[0] ?? tx.workspace.create({ data: { name: 'Workspace' }, select: { id: true } });
  }, { isolationLevel: 'ReadCommitted' });
}
