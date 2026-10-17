import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { sectionUpdate } from "@/lib/schemas";
import { deleteSection, updateSection } from "@/lib/sections";

type Ctx = { params: Promise<{ id: string; sectionId: string }> };

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const { id, sectionId } = await ctx.params;
  await updateSection(me, id, sectionId, await parseBody(req, sectionUpdate));
  return Response.json({ status: "ok" });
});

// DELETE /api/projects/:id/sections/:sectionId?moveTo=<sectionId>
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const { id, sectionId } = await ctx.params;
  await deleteSection(me, id, sectionId, new URL(req.url).searchParams.get("moveTo") ?? undefined);
  return new Response(null, { status: 204 });
});
