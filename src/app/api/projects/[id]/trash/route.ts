import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { listTrash } from "@/lib/tasks";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
  Response.json({ items: await listTrash(await currentUser(), (await ctx.params).id) }),
);
