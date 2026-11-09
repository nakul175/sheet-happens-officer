import type { Prisma, User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/http';

export const multiWorkspaceEnabled = () => process.env.SHO_MULTI_WORKSPACE_ENABLED === 'true';
export type WorkspaceActor = { id: string; workspaceId?: string; workspaceGeneration?: number | null };
type Store = Pick<Prisma.TransactionClient, 'user' | 'workspaceMembership'>;
const unavailable = () => new ApiError(403, 'Choose an available workspace.', { code: 'WORKSPACE_UNAVAILABLE' });
/** Explicit selected scope; never infer a destination from a request resource. */
export function workspaceScope(actor: WorkspaceActor): {workspaceId?: string} {
  if (!multiWorkspaceEnabled()) return {};
  if (!actor.workspaceId) throw unavailable();
  return { workspaceId: actor.workspaceId };
}
export function workspacePeopleWhere(workspaceId: string): Prisma.UserWhereInput {
  return multiWorkspaceEnabled() ? { AND: [{ OR: [{workspaceId}, {additionalWorkspaces:{some:{workspaceId,revokedAt:null}}}] }] } : {workspaceId};
}
/** Re-read authority without replacing a person's original stored workspace/role. */
export async function scopedUser(actor: WorkspaceActor, store: Store = db) {
  const u = await store.user.findUniqueOrThrow({where:{id:actor.id}});
  return resolveScopedUser(actor, u, store);
}
/** Preserve nullable account lookups used by callers with their own 401/404 response. */
export async function findScopedUser(actor: WorkspaceActor, store: Store = db) {
  const u = await store.user.findUnique({where:{id:actor.id}});
  return u ? resolveScopedUser(actor, u, store) : null;
}
async function resolveScopedUser(actor: WorkspaceActor, u: User, store: Store) {
  if (!multiWorkspaceEnabled()) return u;
  if (u.deactivatedAt || !u.emailVerifiedAt || !actor.workspaceId) throw unavailable();
  if (u.workspaceId === actor.workspaceId) return u;
  const m = await store.workspaceMembership.findUnique({where:{userId_workspaceId:{userId:u.id,workspaceId:actor.workspaceId}}});
  if (!m || m.revokedAt || m.generation!==actor.workspaceGeneration || !['MEMBER','ADMIN'].includes(m.role)) throw unavailable();
  return {...u,workspaceId:m.workspaceId,orgRole:m.role,workspaceGeneration:m.generation};
}
export async function personInWorkspace(userId: string, workspaceId: string, store: Store = db) {
  const u=await store.user.findUnique({where:{id:userId}});
  if (!u || u.deactivatedAt || !u.emailVerifiedAt) return null;
  if (u.workspaceId===workspaceId) return u;
  if (!multiWorkspaceEnabled()) return null;
  const m=await store.workspaceMembership.findUnique({where:{userId_workspaceId:{userId,workspaceId}}});
  return m && !m.revokedAt && ['MEMBER','ADMIN'].includes(m.role) ? {...u,workspaceId,orgRole:m.role} : null;
}
/** Global identity operations must not be inherited from an additional membership. */
export async function requireOriginalAccountAdministration(actor: WorkspaceActor, targetId?: string) {
  if (!multiWorkspaceEnabled()) return;
  const original=await db.user.findUniqueOrThrow({where:{id:actor.id}});
  if (original.workspaceId!==actor.workspaceId) throw new ApiError(403,'Manage this account through Aplyd.');
  if (targetId) {
    const target=await db.user.findUnique({where:{id:targetId}});
    if (!target || target.workspaceId!==actor.workspaceId || await db.workspaceMembership.count({where:{userId:targetId}}))
      throw new ApiError(403,'Manage this account through Aplyd.');
  }
}
