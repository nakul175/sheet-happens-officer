import type { Tx } from "@/lib/access";
import { ApiError } from "@/lib/http";

/** Hold the project and task participants through a task write.
 * Membership departure may lock a member first; NOWAIT avoids waiting in the
 * reverse order while a task writer owns another row. */
export async function lockTaskProjectAndPeople(tx: Tx, projectId: string, ids: (string | null | undefined)[]) {
  try {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR SHARE NOWAIT`;
    for (const personId of [...new Set(ids.filter((id): id is string => !!id))].sort()) {
      await tx.$queryRaw`SELECT "userId" FROM "ProjectMember" WHERE "projectId" = ${projectId} AND "userId" = ${personId} FOR SHARE NOWAIT`;
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${personId} FOR SHARE NOWAIT`;
    }
  } catch (error) {
    const failure = error as { code?: string; meta?: { code?: string } } | null;
    if (failure?.code === 'P2010' && failure.meta?.code === '55P03') {
      throw new ApiError(409, "Project membership is changing. Reload and try again.");
    }
    throw error;
  }
}
