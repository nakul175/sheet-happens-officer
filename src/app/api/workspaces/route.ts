import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { currentUser, currentSessionId } from '@/lib/auth';
import { db } from '@/lib/db';
import { ApiError, handle, parseBody } from '@/lib/http';
import { multiWorkspaceEnabled } from '@/lib/workspace-authority';
function table(name: 'Session' | 'User' | 'WorkspaceMembership') {
 const schema=new URL(process.env.DATABASE_URL!).searchParams.get('schema') ?? 'public';
 return Prisma.raw('"'+schema.replaceAll('"','""')+'"."'+name+'"');
}
const noStore={'Cache-Control':'private, no-store'};
function enabled(){if(!multiWorkspaceEnabled())throw new ApiError(404,'Not found');}

export const GET=handle(async()=>{
 enabled();
 const u=await currentUser({workspaceNeutral:true});
 const sid=await currentSessionId();
 if(!sid)throw new ApiError(401,'Not signed in');
 const [home,members,selection]=await Promise.all([
  db.workspace.findUniqueOrThrow({where:{id:u.workspaceId},select:{id:true,name:true}}),
  db.workspaceMembership.findMany({where:{userId:u.id,revokedAt:null},include:{workspace:{select:{id:true,name:true}}},orderBy:{workspaceId:'asc'}}),
  db.sessionWorkspace.findUnique({where:{sessionId:sid},include:{membership:true}}),
 ]);
 const available=!selection || (!selection.membership.revokedAt && selection.generation===selection.membership.generation);
 return Response.json({selected:selection?.workspaceId??u.workspaceId,available,workspaces:[
  {...home,role:u.orgRole,original:true},...members.map(m=>({...m.workspace,role:m.role,original:false})),
 ]},{headers:noStore});
});
export const POST=handle(async(req:Request)=>{
 enabled();
 // Same-site cookies alone are not a CSRF decision. No cross-origin fallback.
 const origin=process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(req.url).origin;
 if(req.headers.get('origin')!==origin || req.headers.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'Invalid origin');
 const u=await currentUser({workspaceNeutral:true}),sid=await currentSessionId();
 const {workspaceId}=await parseBody(req,z.object({workspaceId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)}).strict());
 if(!sid)throw new ApiError(401,'Not signed in');
 await db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM ${table('Session')} WHERE id=${sid} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM ${table('User')} WHERE id=${u.id} FOR SHARE`;
  const session=await tx.session.findUnique({where:{id:sid},include:{user:true}});
  if(!session || session.userId!==u.id || session.revokedAt || session.expiresAt<=new Date() || session.user.deactivatedAt || !session.user.emailVerifiedAt)throw new ApiError(401,'Not signed in');
  if(workspaceId===session.user.workspaceId){await tx.sessionWorkspace.deleteMany({where:{sessionId:sid}});return;}
  await tx.$queryRaw`SELECT "userId" FROM ${table('WorkspaceMembership')} WHERE "userId"=${u.id} AND "workspaceId"=${workspaceId} FOR SHARE`;
  const m=await tx.workspaceMembership.findUnique({where:{userId_workspaceId:{userId:u.id,workspaceId}}});
  if(!m || m.revokedAt || !['MEMBER','ADMIN'].includes(m.role))throw new ApiError(403,'Workspace is unavailable');
  await tx.sessionWorkspace.upsert({where:{sessionId:sid},create:{sessionId:sid,userId:u.id,workspaceId,generation:m.generation},update:{workspaceId,generation:m.generation,selectedAt:new Date()}});
 },{isolationLevel:'Serializable',timeout:8000});
 return Response.json({selected:workspaceId},{headers:noStore});
});
