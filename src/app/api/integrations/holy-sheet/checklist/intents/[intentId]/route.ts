import { z } from "zod";
import { handle } from "@/lib/http";
import { holySheetSuiteActor } from "@/lib/suite-oauth";
import { checklistTaskReceipt } from "@/lib/holy-sheet-checklist-tasks";

export const GET = handle(async (req: Request, context: { params: Promise<{ intentId: string }> }) => {
  const { user, subject } = await holySheetSuiteActor(req);
  const intentId = z.string().uuid().parse((await context.params).intentId);
  return Response.json(await checklistTaskReceipt(user, subject, intentId));
});
