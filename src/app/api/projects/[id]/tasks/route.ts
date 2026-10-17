import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskCreate } from "@/lib/schemas";
import { createTask, listTasks } from "@/lib/tasks";

type Ctx = { params: Promise<{ id: string }> };

// GET ?sectionId=&cursor=&limit=&all=true  (no sectionId returns the first page of every Section)
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const q = new URL(req.url).searchParams;
  return Response.json(
    await listTasks(me, (await ctx.params).id, {
      sectionId: q.get("sectionId") ?? undefined,
      cursor: q.get("cursor") ?? undefined,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      all: q.get("all") === "true",
    }),
  );
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const id = await createTask(me, (await ctx.params).id, await parseBody(req, taskCreate));
  return Response.json({ task: { id } }, { status: 201 });
});
