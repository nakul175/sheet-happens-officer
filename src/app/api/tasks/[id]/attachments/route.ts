import { currentUser } from "@/lib/auth";
import { ApiError, handle } from "@/lib/http";
import { addAttachment, attachmentTask, listAttachments, requireAttachments } from "@/lib/attachments";
import { attachmentForm } from "@/lib/attachment-upload";
type Ctx = { params: Promise<{ id: string }> };
export const GET = handle(async (_req: Request, ctx: Ctx) => { requireAttachments(); return Response.json(await listAttachments(await currentUser(), (await ctx.params).id)); });
export const POST = handle(async (req: Request, ctx: Ctx) => {
  requireAttachments(); const user = await currentUser(), id = (await ctx.params).id;
  await attachmentTask(user, id, true); // access before reading any content
  const form = await attachmentForm(req), file = form.get("file");
  if (!(file instanceof File) || form.getAll("file").length !== 1) throw new ApiError(400, "Choose one PDF file.");
  return Response.json({ file: await addAttachment(user, id, file) }, { status: 201 });
});
