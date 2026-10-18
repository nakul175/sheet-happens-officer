import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { editComment, removeComment } from "@/lib/comments";
import { handle, parseBody } from "@/lib/http";

type Ctx = { params: Promise<{ id: string; commentId: string }> };

const body = z.object({
  text: z.string().max(20000).optional(),
  mentions: z.array(z.string()).max(100).optional(),
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const { id, commentId } = await ctx.params;
  const comment = await editComment(me, id, commentId, await parseBody(req, body));
  return Response.json({
    comment: { id: comment.id, text: comment.text, editedAt: comment.editedAt?.toISOString() ?? null, createdAt: comment.createdAt.toISOString() },
  });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const { id, commentId } = await ctx.params;
  await removeComment(me, id, commentId);
  return new Response(null, { status: 204 });
});
