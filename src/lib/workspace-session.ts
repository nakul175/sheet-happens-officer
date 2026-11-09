import { db } from '@/lib/db';
import { ApiError } from '@/lib/http';
import { multiWorkspaceEnabled } from '@/lib/workspace-authority';

export async function selectedSessionWorkspace(sessionId: string) {
  const enabled=multiWorkspaceEnabled();
  let selection;
  try {
    selection=await db.sessionWorkspace.findUnique({where:{sessionId},include:{membership:true}});
  } catch (error) {
    // An un-migrated, disabled installation retains the original single-workspace flow.
    // Once selections exist, disabling the feature must not silently switch authority.
    const e=error as {code?:string;meta?:{table?:string}};
    if(!enabled && e.code==='P2021' && /(?:^|[.])SessionWorkspace$/.test(e.meta?.table??''))return null;
    throw error;
  }
  if (!selection) return null;
  const m=selection.membership;
  if(!enabled || m.revokedAt || m.generation!==selection.generation || !['MEMBER','ADMIN'].includes(m.role))
    throw new ApiError(403,'Choose an available workspace.',{code:'WORKSPACE_UNAVAILABLE'});
  return {workspaceId:m.workspaceId,orgRole:m.role,workspaceGeneration:m.generation};
}
