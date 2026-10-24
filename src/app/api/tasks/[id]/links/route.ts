import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { addTaskLink } from "@/lib/records";
import { taskLinkCreate } from "@/lib/schemas";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const l = await addTaskLink(me, (await ctx.params).id, await parseBody(req, taskLinkCreate));
  return Response.json({ link: { id: l.id } }, { status: 201 });
});
