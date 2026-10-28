import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { attachmentTrash, requireAttachments } from "@/lib/attachments";
export const GET = handle(async (_req:Request,ctx:{params:Promise<{id:string}>})=>{requireAttachments(); return Response.json(await attachmentTrash(await currentUser(),(await ctx.params).id));});
