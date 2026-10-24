import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskIdea } from "@/lib/schemas";
import { setIdea } from "@/lib/tasks";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  await setIdea(me, (await ctx.params).id, (await parseBody(req, taskIdea)).isIdea);
  return Response.json({ status: "ok" });
});
