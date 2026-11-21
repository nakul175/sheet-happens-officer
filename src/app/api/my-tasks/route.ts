import { currentUser } from "@/lib/auth";
import { dealsNeedingNextStep } from "@/lib/deals";
import { handle } from "@/lib/http";
import { myTasks } from "@/lib/tasks";
import { myTasksPaged } from "@/lib/my-tasks-paged";

export const GET = handle(async (req: Request) => {
  const me = await currentUser();
  const query = new URL(req.url).searchParams;
  if (query.get("v") === "2") return Response.json(await myTasksPaged(me, query));
  return Response.json({ ...(await myTasks(me)), needsNextStep: await dealsNeedingNextStep(me) });
});
