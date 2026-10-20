import { currentUser } from "@/lib/auth";
import { ApiError, handle, withVersionErrors } from "@/lib/http";
import { taskUpdate } from "@/lib/schemas";
import { versionFirst } from "@/lib/task-version";
import { assertCanUpdateTask, deleteTask, getTask, updateTask } from "@/lib/tasks";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) =>
  Response.json({ task: await getTask(await currentUser(), (await ctx.params).id) }),
);

export const PATCH = handle(withVersionErrors(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  // Access is decided before the body is read (APL-2651).
  // An outsider gets the same 404 { error: "Task not found" } as a missing task (F8).
  await assertCanUpdateTask(me, id);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "Body must be valid JSON");
  }
  // Every edit carries expectedUpdatedAt, Blocked included (APL-2670 AC1 v1.4 drops the APL-2494 exemption).
  // Session, access, version, then schema (APL-2670 AC1 v1.4).
  versionFirst(raw);
  await updateTask(me, id, taskUpdate.parse(raw));
  return Response.json({ task: await getTask(me, id) });
}));

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await deleteTask(await currentUser(), (await ctx.params).id);
  return new Response(null, { status: 204 });
});
