import { currentUser } from "@/lib/auth";
import { ApiError, handle } from "@/lib/http";
import { taskUpdate } from "@/lib/schemas";
import { assertCanUpdateTask, deleteTask, getTask, stampBlockedFlagVersion, updateTask } from "@/lib/tasks";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) =>
  Response.json({ task: await getTask(await currentUser(), (await ctx.params).id) }),
);

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  const { t } = await assertCanUpdateTask(me, id);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "Body must be valid JSON");
  }
  await updateTask(me, id, taskUpdate.parse(stampBlockedFlagVersion(raw, t.updatedAt)));
  return Response.json({ task: await getTask(me, id) });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await deleteTask(await currentUser(), (await ctx.params).id);
  return new Response(null, { status: 204 });
});
