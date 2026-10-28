import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { requireAttachments, restoreAttachment } from "@/lib/attachments";
export const POST = handle(async (_req: Request, ctx: {params:Promise<{id:string;fileId:string}>}) => { requireAttachments(); const {id,fileId}=await ctx.params; await restoreAttachment(await currentUser(),id,fileId); return Response.json({restored:true}); });
