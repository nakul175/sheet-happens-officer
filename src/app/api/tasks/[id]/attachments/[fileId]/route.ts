import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { downloadAttachment, removeAttachment, requireAttachments } from "@/lib/attachments";
type Ctx = { params: Promise<{ id: string; fileId: string }> };
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  requireAttachments(); const user = await currentUser(), { id, fileId } = await ctx.params;
  const file = await downloadAttachment(user, id, fileId);
  return new Response(Buffer.from(file.bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="download.pdf"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, c => "%"+c.charCodeAt(0).toString(16))}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
});
export const DELETE = handle(async (_req: Request, ctx: Ctx) => { requireAttachments(); const {id,fileId}=await ctx.params; await removeAttachment(await currentUser(),id,fileId); return new Response(null,{status:204}); });
