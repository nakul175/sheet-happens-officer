import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { sendBack } from "@/lib/tasks";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await sendBack(await currentUser(), (await ctx.params).id);
  return Response.json({ status: "ok" });
});
