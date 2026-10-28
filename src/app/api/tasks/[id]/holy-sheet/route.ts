import { currentUser, currentSessionId } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError, handle } from "@/lib/http";
import { getTask } from "@/lib/tasks";
import { centralSessionActive } from "@/lib/central-status";
import { holySheetOrigin } from "@/lib/holy-sheet-url";

export const GET = async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const response = await handle(async () => {
    const origin = holySheetOrigin();
    if (!origin) throw new ApiError(404, "Not found");
    const me = await currentUser();
    await getTask(me, (await ctx.params).id);
    const sessionId = await currentSessionId();
    const session = sessionId ? await db.session.findUnique({ where: { id: sessionId }, include: { centralLink: true } }) : null;
    const central = session?.centralLink;
    if (!session || session.userId !== me.id || session.revokedAt || session.expiresAt <= new Date() || !central ||
        !central.subject || central.subject.length > 200 || /[\u0000-\u0020\u007f]/.test(central.subject) ||
        !(await centralSessionActive(central.subject, central.sessionUid, me.id))) {
      throw new ApiError(401, "Sign in with Aplyd to open Holy Sheet.");
    }
    return Response.json({ origin, subject: central.subject });
  })();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};
