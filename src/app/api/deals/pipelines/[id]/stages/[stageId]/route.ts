import { currentUser } from "@/lib/auth";
import { removeStage } from "@/lib/deals";
import { handle, parseBody } from "@/lib/http";
import { stageRemove } from "@/lib/schemas";

export const DELETE = handle(async (req: Request, ctx: { params: Promise<{ id: string; stageId: string }> }) => {
  const me = await currentUser();
  const { id, stageId } = await ctx.params;
  const body = await parseBody(req, stageRemove).catch(() => ({ moveToStageId: undefined }));
  return Response.json(await removeStage(me, id, stageId, body.moveToStageId));
});
