import { currentUser } from "@/lib/auth";
import { handle, parseTaskBody, withVersionErrors } from "@/lib/http";
import { taskUpdate } from "@/lib/schemas";
import { deleteTask, getTask, updateTask } from "@/lib/tasks";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) =>
  Response.json({ task: await getTask(await currentUser(), (await ctx.params).id) }),
);

export const PATCH = handle(withVersionErrors(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  await updateTask(me, (await ctx.params).id, await parseTaskBody(req, taskUpdate));
  return Response.json({ task: await getTask(me, (await ctx.params).id) });
}));

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await deleteTask(await currentUser(), (await ctx.params).id);
  return new Response(null, { status: 204 });
});
