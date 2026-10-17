import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { addMember } from "@/lib/projects";
import { memberAdd } from "@/lib/schemas";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const { userId, role } = await parseBody(req, memberAdd);
  await addMember(me, (await ctx.params).id, userId, role);
  return Response.json({ status: "ok" }, { status: 201 });
});
