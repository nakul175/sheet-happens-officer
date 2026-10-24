import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { taskCreate } from "@/lib/schemas";
import { createTask, listTasks } from "@/lib/tasks";
import { listFiltered, parseListFilter, projectSummary } from "@/lib/tasklist";

type Ctx = { params: Promise<{ id: string }> };

// GET ?sectionId=&cursor=&limit=&all=true  (no sectionId returns the first page of every Section)
// SHO-US-14.9: ?assignee=&f=overdue,blocked,awaiting,nodate&priority=&sort=priority returns every matching task (up to 500)
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const q = new URL(req.url).searchParams;
  const id = (await ctx.params).id;
  const filter = q.get("sectionId") ? null : parseListFilter(q);
  const page = filter
    ? await listFiltered(me, id, filter)
    : await listTasks(me, id, {
      sectionId: q.get("sectionId") ?? undefined,
      cursor: q.get("cursor") ?? undefined,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      all: q.get("all") === "true",
    });
  return Response.json(q.get("sectionId") ? page : { ...page, summary: await projectSummary(me, id) });
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const id = await createTask(me, (await ctx.params).id, await parseBody(req, taskCreate));
  return Response.json({ task: { id } }, { status: 201 });
});
