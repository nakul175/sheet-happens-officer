import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { addComment, listComments } from "@/lib/comments";
import { handle, parseBody } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

const body = z.object({
  text: z.string().max(20000).optional(),
  mentions: z.array(z.string()).max(100).optional(),
});

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const me = await currentUser();
  return Response.json(await listComments(me, (await ctx.params).id));
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const comment = await addComment(me, (await ctx.params).id, await parseBody(req, body));
  return Response.json({
    comment: { id: comment.id, text: comment.text, createdAt: comment.createdAt.toISOString(), authorId: comment.authorId },
  }, { status: 201 });
});
