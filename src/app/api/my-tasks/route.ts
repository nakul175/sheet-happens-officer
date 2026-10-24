import { currentUser } from "@/lib/auth";
import { dealsNeedingNextStep } from "@/lib/deals";
import { handle } from "@/lib/http";
import { myTasks } from "@/lib/tasks";

export const GET = handle(async () => {
  const me = await currentUser();
  return Response.json({ ...(await myTasks(me)), needsNextStep: await dealsNeedingNextStep(me) });
});
