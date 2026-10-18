import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskUpdate } from "@/lib/schemas";
import { assertCanUpdateTask, deleteTask, getTask, updateTask } from "@/lib/tasks";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) =>
  Response.json({ task: await getTask(await currentUser(), (await ctx.params).id) }),
);

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  await assertCanUpdateTask(me, id);
  await updateTask(me, id, await parseBody(req, taskUpdate));
  return Response.json({ task: await getTask(me, id) });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await deleteTask(await currentUser(), (await ctx.params).id);
  return new Response(null, { status: 204 });
});
