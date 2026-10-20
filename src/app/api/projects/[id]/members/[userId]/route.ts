import { projectAccess, requireManage } from "@/lib/access";
import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { changeMemberRole, removeMember } from "@/lib/projects";
import { memberRole } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string; userId: string }> };

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const { id, userId } = await ctx.params;
  requireManage(await projectAccess(me, id, { write: true }));
  const { role, handoverTo } = await parseBody(req, memberRole);
  await changeMemberRole(me, id, userId, role, handoverTo);
  return Response.json({ status: "ok" });
});

// DELETE /api/projects/:id/members/:userId?handoverTo=<personId>
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const { id, userId } = await ctx.params;
  await removeMember(me, id, userId, new URL(req.url).searchParams.get("handoverTo"));
  return new Response(null, { status: 204 });
});
