import { db } from '@/lib/db';
import { ApiError } from '@/lib/http';
import { multiWorkspaceEnabled } from '@/lib/workspace-authority';

export async function selectedSessionWorkspace(sessionId: string) {
  if (!multiWorkspaceEnabled()) return null;
  const selection=await db.sessionWorkspace.findUnique({where:{sessionId},include:{membership:true}});
  if (!selection) return null;
  const m=selection.membership;
  if(m.revokedAt || m.generation!==selection.generation || !['MEMBER','ADMIN'].includes(m.role))
    throw new ApiError(403,'Choose an available workspace.',{code:'WORKSPACE_UNAVAILABLE'});
  return {workspaceId:m.workspaceId,orgRole:m.role,workspaceGeneration:m.generation};
}
